import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { extractLastAssistantText, readChildResult } from "./child.ts";
import { HerdrClient, HerdrCommandError } from "./herdr.ts";
import { runLocalChild } from "./local.ts";
import type { ProcessRunner } from "./process.ts";
import { runProcess } from "./process.ts";
import {
  MAX_SUMMARY_BYTES,
  type BatchResult,
  type ChildBackend,
  type ChildProgress,
  type ChildResult,
  type DispatchContext,
  type FleetEntry,
  type RunBatchOptions,
  type SubagentTask,
} from "./types.ts";

export interface OrchestratorOptions {
  runner?: ProcessRunner;
  extensionPath: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

type ProgressCallback = (progress: ChildProgress[]) => void;

interface ParentTabActivity {
  count: number;
  originalLabel?: string;
  waitingLabel?: string;
}

const CHILD_WORKING_ICON = "⏳";
const CHILD_DONE_ICON = "✅";
const CHILD_FAILED_ICON = "❌";
const PARENT_WAITING_ICON = "📋";

class ChildExecutionError extends Error {
  constructor(
    readonly original: unknown,
    readonly paneId: string | undefined,
    readonly tabId: string | undefined,
    readonly agentName: string | undefined,
  ) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "ChildExecutionError";
  }
}

function taskLabel(task: SubagentTask, index: number): string {
  if (task.label?.trim()) return task.label.trim().slice(0, 80);
  const firstLine = task.task.trim().split(/\r?\n/, 1)[0] ?? "";
  return (firstLine || `subagent ${index + 1}`).slice(0, 80);
}

function agentName(toolCallId: string, index: number, now: number): string {
  const call = toolCallId.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(-8);
  const stamp = now.toString(36).slice(-6);
  return `sub-${stamp}-${call || "task"}-${index + 1}`.slice(0, 32).replace(/-+$/, "");
}

function taskPrompt(task: string): string {
  return `<subagent-task>\n${task.trim()}\n</subagent-task>\n\nComplete the task and end with the concise, self-contained summary requested by your subagent instructions.`;
}

function truncateUtf8(text: string, maxBytes = MAX_SUMMARY_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: `${bytes.subarray(0, end).toString("utf8")}\n\n[Summary truncated to ${maxBytes} bytes.]`,
    truncated: true,
  };
}

function classifyError(error: unknown, signal?: AbortSignal): { status: ChildResult["status"]; error: string } {
  if (signal?.aborted) return { status: "aborted", error: "Subagent run was aborted." };
  const original = error instanceof ChildExecutionError ? error.original : error;
  if (
    original instanceof HerdrCommandError &&
    (original.output?.timedOut || original.operation === "pane shell readiness")
  ) {
    return { status: "timed_out", error: original.message };
  }
  return { status: "failed", error: original instanceof Error ? original.message : String(original) };
}

async function validateCwd(parentCwd: string, requested?: string): Promise<string> {
  const cwd = requested ? (isAbsolute(requested) ? requested : resolve(parentCwd, requested)) : parentCwd;
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error(`Subagent cwd is not a directory: ${cwd}`);
  return cwd;
}

async function transcriptFallback(path: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const entries = (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown];
          } catch {
            return [];
          }
        });
      const summary = extractLastAssistantText(entries);
      if (summary) return summary;
    } catch {
      // The integration can report the path just before the final append lands.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  return "";
}

export class SubagentOrchestrator {
  private readonly runner: ProcessRunner;
  private readonly extensionPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly herdr: HerdrClient;
  private readonly fleet = new Map<string, FleetEntry>();
  private readonly parentTabActivity = new Map<string, ParentTabActivity>();

  constructor(options: OrchestratorOptions) {
    this.runner = options.runner ?? runProcess;
    this.extensionPath = options.extensionPath;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.herdr = new HerdrClient(this.runner, this.env.HERDR_BIN || "herdr");
  }

  backend(): ChildBackend {
    return this.env.HERDR_ENV === "1" ? "herdr" : "local";
  }

  listFleet(): FleetEntry[] {
    return [...this.fleet.values()].sort((a, b) => a.createdAt - b.createdAt || a.tabId.localeCompare(b.tabId));
  }

  async closeFleet(tabIds: readonly string[] | undefined, signal?: AbortSignal): Promise<{ closed: string[]; errors: string[] }> {
    const targets = tabIds?.length ? [...new Set(tabIds)] : [...this.fleet.keys()];
    const closed: string[] = [];
    const errors: string[] = [];
    for (const tabId of targets) {
      const entry = this.fleet.get(tabId);
      if (!entry) {
        errors.push(`${tabId}: not owned by this extension instance`);
        continue;
      }
      try {
        await this.herdr.closeTab(tabId, signal);
        this.fleet.delete(tabId);
        closed.push(tabId);
      } catch (error) {
        errors.push(`${tabId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { closed, errors };
  }

  async runBatch(
    toolCallId: string,
    tasks: readonly SubagentTask[],
    dispatch: DispatchContext,
    options: RunBatchOptions,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
  ): Promise<BatchResult> {
    const backend = this.backend();
    if (backend === "herdr" && !this.env.HERDR_WORKSPACE_ID) {
      throw new Error("HERDR_ENV=1 but HERDR_WORKSPACE_ID is missing; refusing a hidden fallback.");
    }

    const progress: ChildProgress[] = tasks.map((task, index) => ({
      index,
      label: taskLabel(task, index),
      backend,
      status: "queued",
    }));
    const emit = (index: number, patch: Partial<ChildProgress>) => {
      progress[index] = { ...progress[index]!, ...patch };
      onProgress?.(progress.map((item) => ({ ...item })));
    };
    onProgress?.(progress.map((item) => ({ ...item })));

    const parentTabId = backend === "herdr" ? this.env.HERDR_TAB_ID : undefined;
    if (parentTabId) await this.beginParentWaiting(parentTabId, signal);
    try {
      const results = new Array<ChildResult>(tasks.length);
      let nextIndex = 0;
      const workers = Array.from({ length: Math.min(options.concurrency, tasks.length) }, async () => {
        for (;;) {
          const index = nextIndex++;
          if (index >= tasks.length) return;
          const task = tasks[index]!;
          results[index] = await this.runOne(
            toolCallId,
            index,
            task,
            dispatch,
            options,
            backend,
            signal,
            (patch) => emit(index, patch),
          );
        }
      });
      await Promise.all(workers);
      return { backend, results };
    } finally {
      if (parentTabId) await this.endParentWaiting(parentTabId);
    }
  }

  private async beginParentWaiting(tabId: string, signal?: AbortSignal): Promise<void> {
    const active = this.parentTabActivity.get(tabId);
    if (active) {
      active.count += 1;
      return;
    }

    const state: ParentTabActivity = { count: 1 };
    this.parentTabActivity.set(tabId, state);
    try {
      const tab = await this.herdr.getTab(tabId, signal);
      const waitingLabel = tab.label.startsWith(`${PARENT_WAITING_ICON} `)
        ? tab.label
        : `${PARENT_WAITING_ICON}${tab.label ? ` ${tab.label}` : ""}`;
      await this.herdr.renameTab(tabId, waitingLabel, signal);
      state.originalLabel = tab.label;
      state.waitingLabel = waitingLabel;
    } catch {
      // Tab markers are best-effort and must never prevent delegation.
    }
  }

  private async endParentWaiting(tabId: string): Promise<void> {
    const state = this.parentTabActivity.get(tabId);
    if (!state) return;
    state.count -= 1;
    if (state.count > 0) return;
    this.parentTabActivity.delete(tabId);
    if (state.originalLabel === undefined || state.waitingLabel === undefined) return;

    try {
      const cleanupSignal = AbortSignal.timeout(3_000);
      const current = await this.herdr.getTab(tabId, cleanupSignal);
      // Do not overwrite a label the user changed while the batch was running.
      if (current.label === state.waitingLabel) {
        await this.herdr.renameTab(tabId, state.originalLabel, cleanupSignal);
      }
    } catch {
      // Restoring a cosmetic marker is best-effort.
    }
  }

  private async runOne(
    toolCallId: string,
    index: number,
    task: SubagentTask,
    dispatch: DispatchContext,
    options: RunBatchOptions,
    backend: ChildBackend,
    signal: AbortSignal | undefined,
    emit: (patch: Partial<ChildProgress>) => void,
  ): Promise<ChildResult> {
    const label = taskLabel(task, index);
    let cwd = dispatch.cwd;
    try {
      signal?.throwIfAborted();
      cwd = await validateCwd(dispatch.cwd, task.cwd);
    } catch (error) {
      const classified = classifyError(error, signal);
      emit({ status: classified.status });
      return { index, label, task: task.task, cwd, backend, ...classified, summary: "" };
    }

    const tempDir = await mkdtemp(join(tmpdir(), "herdr-pi-subagent-"));
    const resultPath = join(tempDir, "result.json");
    try {
      const result = backend === "herdr"
        ? await this.runHerdr(index, label, task.task, cwd, resultPath, toolCallId, dispatch, options, signal, emit)
        : await this.runLocal(index, label, task.task, cwd, resultPath, dispatch, options, signal, emit);
      emit({ status: result.status, paneId: result.paneId, tabId: result.tabId });
      return result;
    } catch (error) {
      const classified = classifyError(error, signal);
      const childError = error instanceof ChildExecutionError ? error : undefined;
      emit({ status: classified.status, paneId: childError?.paneId, tabId: childError?.tabId });
      return {
        index,
        label,
        task: task.task,
        cwd,
        backend,
        ...classified,
        summary: "",
        ...(childError?.paneId ? { paneId: childError.paneId } : {}),
        ...(childError?.tabId ? { tabId: childError.tabId } : {}),
        ...(childError?.agentName ? { agentName: childError.agentName } : {}),
      };
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private async runLocal(
    index: number,
    label: string,
    task: string,
    cwd: string,
    resultPath: string,
    dispatch: DispatchContext,
    options: RunBatchOptions,
    signal: AbortSignal | undefined,
    emit: (patch: Partial<ChildProgress>) => void,
  ): Promise<ChildResult> {
    emit({ status: "working" });
    const output = await runLocalChild({
      runner: this.runner,
      cwd,
      taskPrompt: taskPrompt(task),
      resultPath,
      extensionPath: this.extensionPath,
      model: dispatch.model,
      thinkingLevel: dispatch.thinkingLevel,
      timeoutMs: options.timeoutMs,
      signal,
      env: this.env,
    });

    const summary = output.result?.summary || output.fallbackSummary;
    const status: ChildResult["status"] = output.aborted
      ? "aborted"
      : output.timedOut
        ? "timed_out"
        : output.result?.status === "completed" || (summary && !output.error)
          ? "completed"
          : "failed";
    const capped = truncateUtf8(summary);
    return {
      index,
      label,
      task,
      cwd,
      backend: "local",
      status,
      summary: capped.text,
      ...(output.result?.error || output.error ? { error: output.result?.error || output.error } : {}),
      ...(capped.truncated ? { truncated: true } : {}),
    };
  }

  private async markChildTab(tabId: string, icon: string, label: string): Promise<void> {
    try {
      await this.herdr.renameTab(tabId, `${icon} ${label}`, AbortSignal.timeout(2_000));
    } catch {
      // Status markers are best-effort and must not change child results.
    }
  }

  private async runHerdr(
    index: number,
    label: string,
    task: string,
    cwd: string,
    resultPath: string,
    toolCallId: string,
    dispatch: DispatchContext,
    options: RunBatchOptions,
    signal: AbortSignal | undefined,
    emit: (patch: Partial<ChildProgress>) => void,
  ): Promise<ChildResult> {
    const name = agentName(toolCallId, index, this.now());
    let tabId: string | undefined;
    let paneId: string | undefined;
    let completed = false;
    try {
      emit({ status: "starting" });
      const tab = await this.herdr.createTab({
        workspaceId: this.env.HERDR_WORKSPACE_ID!,
        cwd,
        label: `${CHILD_WORKING_ICON} ${label}`,
        env: { HERDR_SUBAGENT: "1", HERDR_SUBAGENT_RESULT_FILE: resultPath },
        signal,
      });
      tabId = tab.tabId;
      paneId = tab.paneId;
      this.fleet.set(tabId, {
        tabId,
        paneId,
        agentName: name,
        label,
        cwd,
        status: "starting",
        createdAt: this.now(),
      });
      emit({ status: "starting", tabId, paneId });

      const piArgs = ["--extension", this.extensionPath, "--name", label];
      if (dispatch.model) piArgs.push("--model", dispatch.model);
      if (dispatch.thinkingLevel) piArgs.push("--thinking", dispatch.thinkingLevel);
      await this.herdr.startAgentWhenReady({
        paneId,
        name,
        piArgs,
        signal,
        shellTimeoutMs: Math.min(10_000, options.timeoutMs),
      });

      const runningEntry = this.fleet.get(tabId);
      if (runningEntry) runningEntry.status = "working";
      emit({ status: "working", tabId, paneId });
      const promptSnapshot = await this.herdr.promptAgent({
        paneId,
        prompt: taskPrompt(task),
        timeoutMs: options.timeoutMs,
        signal,
      });
      if (promptSnapshot.agent_status === "blocked") {
        throw new Error(`Child ${label} is blocked and requires human input.`);
      }

      let childResult = await readChildResult(resultPath, { signal, attempts: 20, delayMs: 100 });
      let summary = childResult?.summary ?? "";
      if (!summary) {
        const snapshot = promptSnapshot.agent_session ? promptSnapshot : await this.herdr.getAgent(paneId, signal);
        const session = snapshot.agent_session;
        if (session?.kind === "path" && session.value) summary = await transcriptFallback(session.value);
      }
      if (!summary && childResult?.status !== "failed") {
        throw new Error(`Child ${label} completed without a collectable summary.`);
      }

      const capped = truncateUtf8(summary);
      completed = childResult?.status !== "failed";
      if (completed) await this.markChildTab(tabId, CHILD_DONE_ICON, label);
      const result: ChildResult = {
        index,
        label,
        task,
        cwd,
        backend: "herdr",
        status: completed ? "completed" : "failed",
        summary: capped.text,
        paneId,
        tabId,
        agentName: name,
        ...(childResult?.error
          ? { error: childResult.error }
          : childResult?.status === "failed"
            ? { error: `Child ${label} failed without an error message.` }
            : {}),
        ...(capped.truncated ? { truncated: true } : {}),
      };
      if (completed && options.keepTabs) {
        const completedEntry = this.fleet.get(tabId);
        if (completedEntry) completedEntry.status = "completed";
      }
      return result;
    } catch (error) {
      throw new ChildExecutionError(error, paneId, tabId, name);
    } finally {
      if (tabId && !completed) await this.markChildTab(tabId, CHILD_FAILED_ICON, label);
      if (tabId && (!completed || !options.keepTabs)) {
        let closed = false;
        try {
          // Cleanup must outlive the parent abort, but it is independently
          // bounded so cancellation cannot hang on a Herdr CLI call.
          await this.herdr.closeTab(tabId, AbortSignal.timeout(5_000));
          closed = true;
        } catch {
          // Keep an owned fleet entry when cleanup fails so list/close can retry it.
          const failedEntry = this.fleet.get(tabId);
          if (failedEntry) failedEntry.status = "failed";
        }
        if (closed) this.fleet.delete(tabId);
      }
    }
  }
}
