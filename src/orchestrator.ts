import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { CHILD_SILENT_ENV, extractLastAssistantText, readChildResult } from "./child.ts";
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

class ChildResultTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`Child ${label} did not publish a result within ${timeoutMs}ms.`);
    this.name = "ChildResultTimeoutError";
  }
}

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
    original instanceof ChildResultTimeoutError ||
    (original instanceof HerdrCommandError &&
      (original.output?.timedOut || original.operation === "pane shell readiness"))
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
  private readonly resultPaths = new Map<string, string>();
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
      if (entry.status === "starting" || entry.status === "working") {
        errors.push(`${tabId}: subagent is busy`);
        continue;
      }
      try {
        await this.herdr.closeTab(tabId, signal);
        await this.discardTabState(tabId);
        closed.push(tabId);
      } catch (error) {
        errors.push(`${tabId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { closed, errors };
  }

  private async discardTabState(tabId: string): Promise<void> {
    this.fleet.delete(tabId);
    const resultPath = this.resultPaths.get(tabId);
    this.resultPaths.delete(tabId);
    if (!resultPath) return;
    try {
      await rm(dirname(resultPath), { recursive: true, force: true });
    } catch {
      // The tab is already closed and private temporary data is best-effort cleanup.
    }
  }

  async promptRetained(
    tabId: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ChildResult> {
    if (this.backend() !== "herdr") {
      throw new Error("subagent action=prompt requires Herdr; local subagents exit after completion.");
    }
    const entry = this.fleet.get(tabId);
    if (!entry) throw new Error(`${tabId}: not owned by this extension instance`);
    if (!entry.reusable) throw new Error(`${tabId}: subagent is not reusable`);
    if (entry.status === "starting" || entry.status === "working") {
      throw new Error(`${tabId}: subagent is busy`);
    }
    const resultPath = this.resultPaths.get(tabId);
    if (!resultPath) throw new Error(`${tabId}: reusable result channel is unavailable`);

    entry.status = "working";
    const parentTabId = this.env.HERDR_TAB_ID;
    if (parentTabId) await this.beginParentWaiting(parentTabId, signal);
    await this.markChildTab(tabId, CHILD_WORKING_ICON, entry.label);

    try {
      signal?.throwIfAborted();
      await rm(resultPath, { force: true });
      const resultNotBeforeMs = Date.now();
      const promptSnapshot = await this.herdr.promptAgent({
        paneId: entry.paneId,
        prompt: taskPrompt(prompt),
        timeoutMs,
        signal,
        wait: false,
      });
      if (promptSnapshot.agent_status === "blocked") {
        throw new Error(`Child ${entry.label} is blocked and requires human input.`);
      }

      const childResult = await readChildResult(resultPath, {
        signal,
        attempts: Math.max(1, Math.ceil(timeoutMs / 100)),
        delayMs: 100,
        notBeforeMs: resultNotBeforeMs,
      });
      let summary = childResult?.summary ?? "";
      if (!summary) {
        const snapshot = promptSnapshot.agent_session
          ? promptSnapshot
          : await this.herdr.getAgent(entry.paneId, signal);
        const session = snapshot.agent_session;
        if (session?.kind === "path" && session.value) summary = await transcriptFallback(session.value);
      }
      if (!summary && !childResult) throw new ChildResultTimeoutError(entry.label, timeoutMs);
      if (!summary && childResult && childResult.status !== "failed") {
        throw new Error(`Child ${entry.label} completed without a collectable summary.`);
      }

      const completed = childResult?.status !== "failed";
      const capped = truncateUtf8(summary);
      entry.status = completed ? "completed" : "failed";
      await this.markChildTab(tabId, completed ? CHILD_DONE_ICON : CHILD_FAILED_ICON, entry.label);
      return {
        index: 0,
        label: entry.label,
        task: prompt,
        cwd: entry.cwd,
        backend: "herdr",
        status: completed ? "completed" : "failed",
        summary: capped.text,
        paneId: entry.paneId,
        tabId,
        agentName: entry.agentName,
        ...(childResult?.error
          ? { error: childResult.error }
          : childResult?.status === "failed"
            ? { error: `Child ${entry.label} failed without an error message.` }
            : {}),
        ...(capped.truncated ? { truncated: true } : {}),
      };
    } catch (error) {
      const classified = classifyError(error, signal);
      entry.status = "failed";
      entry.reusable = false;
      await this.markChildTab(tabId, CHILD_FAILED_ICON, entry.label);
      let closed = false;
      try {
        await this.herdr.closeTab(tabId, AbortSignal.timeout(5_000));
        closed = true;
      } catch {
        // Keep failed ownership when bounded cleanup fails so close can retry.
      }
      if (closed) await this.discardTabState(tabId);
      return {
        index: 0,
        label: entry.label,
        task: prompt,
        cwd: entry.cwd,
        backend: "herdr",
        ...classified,
        summary: "",
        paneId: entry.paneId,
        tabId,
        agentName: entry.agentName,
      };
    } finally {
      if (parentTabId) await this.endParentWaiting(parentTabId);
    }
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
    const childDispatch: DispatchContext = {
      ...dispatch,
      thinkingLevel: task.effort ?? dispatch.thinkingLevel,
    };
    try {
      const result = backend === "herdr"
        ? await this.runHerdr(index, label, task.task, cwd, resultPath, toolCallId, childDispatch, options, signal, emit)
        : await this.runLocal(index, label, task.task, cwd, resultPath, childDispatch, options, signal, emit);
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
        env: {
          HERDR_SUBAGENT: "1",
          HERDR_SUBAGENT_RESULT_FILE: resultPath,
          [CHILD_SILENT_ENV]: "1",
        },
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
        reusable: false,
        createdAt: this.now(),
      });
      this.resultPaths.set(tabId, resultPath);
      emit({ status: "starting", tabId, paneId });

      const piArgs = ["--no-extensions", "--extension", this.extensionPath, "--name", label];
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
        wait: false,
      });
      if (promptSnapshot.agent_status === "blocked") {
        throw new Error(`Child ${label} is blocked and requires human input.`);
      }

      const childResult = await readChildResult(resultPath, {
        signal,
        attempts: Math.max(1, Math.ceil(options.timeoutMs / 100)),
        delayMs: 100,
      });
      let summary = childResult?.summary ?? "";
      if (!summary) {
        const snapshot = promptSnapshot.agent_session ? promptSnapshot : await this.herdr.getAgent(paneId, signal);
        const session = snapshot.agent_session;
        if (session?.kind === "path" && session.value) summary = await transcriptFallback(session.value);
      }
      if (!summary && !childResult) throw new ChildResultTimeoutError(label, options.timeoutMs);
      if (!summary && childResult && childResult.status !== "failed") {
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
        if (completedEntry) {
          completedEntry.status = "completed";
          completedEntry.reusable = true;
        }
      }
      return result;
    } catch (error) {
      throw new ChildExecutionError(error, paneId, tabId, name);
    } finally {
      if (tabId && !completed) await this.markChildTab(tabId, CHILD_FAILED_ICON, label);
      if (tabId && (!completed || !options.keepTabs)) {
        const closingEntry = this.fleet.get(tabId);
        if (closingEntry) closingEntry.reusable = false;
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
        if (closed) await this.discardTabState(tabId);
      }
    }
  }
}
