import type { ProcessOutput, ProcessRunner } from "./process.ts";

interface HerdrEnvelope<T> {
  result?: T;
  error?: { code?: string; message?: string };
}

interface TabCreatePayload {
  root_pane?: { pane_id?: string; tab_id?: string; workspace_id?: string };
}

interface TabListPayload {
  tabs?: Array<{ tab_id?: string; label?: string }>;
}

interface TabPayload {
  tab?: { tab_id?: string; label?: string };
}

export interface HerdrTab {
  tabId: string;
  label: string;
}

interface PaneListPayload {
  panes?: Array<{ pane_id?: string; tab_id?: string }>;
}

interface PaneProcessInfoPayload {
  process_info?: {
    pane_id?: string;
    shell_pid?: number;
    foreground_process_group_id?: number;
  };
}

export interface HerdrAgentSnapshot {
  agent_status?: string;
  pane_id?: string;
  tab_id?: string;
  agent_session?: { kind?: "path" | "id"; value?: string };
}

interface AgentPayload {
  agent?: HerdrAgentSnapshot;
}

export interface CreatedTab {
  paneId: string;
  tabId: string;
}

export class HerdrCommandError extends Error {
  constructor(
    readonly operation: string,
    message: string,
    readonly output?: ProcessOutput,
  ) {
    super(`Herdr ${operation} failed: ${message}`);
    this.name = "HerdrCommandError";
  }
}

function parseEnvelope<T>(text: string): HerdrEnvelope<T> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as HerdrEnvelope<T>;
  } catch {
    return undefined;
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isShellBusyError(error: unknown): boolean {
  return (
    error instanceof HerdrCommandError &&
    (error.message.includes("not an available shell") || error.message.includes("agent_pane_busy"))
  );
}

function outputError(operation: string, output: ProcessOutput): never {
  const envelope = parseEnvelope<never>(output.stderr) ?? parseEnvelope<never>(output.stdout);
  const detail =
    envelope?.error?.message ||
    envelope?.error?.code ||
    output.spawnError ||
    output.stderr.trim() ||
    output.stdout.trim() ||
    `exit ${output.code}`;
  const reason = output.aborted ? "aborted" : output.timedOut ? "timed out" : detail || `exit ${output.code}`;
  throw new HerdrCommandError(operation, reason, output);
}

export class HerdrClient {
  private createTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly runner: ProcessRunner,
    private readonly binary = process.env.HERDR_BIN || "herdr",
  ) {}

  private serializeCreate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.createTail.then(operation);
    this.createTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async call<T>(
    operation: string,
    args: string[],
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const output = await this.runner({
      command: this.binary,
      args,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      env: { ...process.env },
    });
    const envelope = parseEnvelope<T>(output.stdout);
    const hasResult = envelope !== undefined && Object.prototype.hasOwnProperty.call(envelope, "result");
    if (output.code !== 0 || output.aborted || output.timedOut || !hasResult) {
      outputError(operation, output);
    }
    if (envelope?.error) throw new HerdrCommandError(operation, envelope.error.message ?? "unknown error", output);
    return envelope!.result as T;
  }

  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<CreatedTab> {
    // Serialize only tab creation/reconciliation. Child startup and work remain
    // concurrent. This makes a before/after tab-id diff attributable when the
    // CLI loses its response after the server already created the tab.
    return this.serializeCreate(async () => {
      input.signal?.throwIfAborted();
      const before = new Set(await this.listTabIds(input.workspaceId));
      const args = [
        "tab",
        "create",
        "--workspace",
        input.workspaceId,
        "--cwd",
        input.cwd,
        "--label",
        input.label,
        "--no-focus",
      ];
      for (const [key, value] of Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) {
        args.push("--env", `${key}=${value}`);
      }

      try {
        const result = await this.call<TabCreatePayload>("tab create", args, {
          signal: input.signal,
          timeoutMs: 15_000,
        });
        const paneId = result.root_pane?.pane_id;
        const tabId = result.root_pane?.tab_id;
        if (!paneId || !tabId) throw new HerdrCommandError("tab create", "response omitted pane_id or tab_id");
        return { paneId, tabId };
      } catch (error) {
        const recovered = await this.recoverCreatedTab(input.workspaceId, input.label, before);
        if (!recovered) throw error;
        if (input.signal?.aborted) {
          try {
            await this.closeTab(recovered.tabId);
          } catch {
            // The caller still receives the original abort; manual cleanup may be required.
          }
          throw error;
        }
        return recovered;
      }
    });
  }

  private async listTabIds(workspaceId: string): Promise<string[]> {
    const result = await this.call<TabListPayload>("tab list", ["tab", "list", "--workspace", workspaceId], {
      timeoutMs: 10_000,
    });
    return (result.tabs ?? []).flatMap((tab) => (tab.tab_id ? [tab.tab_id] : []));
  }

  private async recoverCreatedTab(
    workspaceId: string,
    label: string,
    before: ReadonlySet<string>,
  ): Promise<CreatedTab | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const tabs = await this.call<TabListPayload>("tab list", ["tab", "list", "--workspace", workspaceId], {
          timeoutMs: 10_000,
        });
        const candidates = (tabs.tabs ?? []).filter(
          (tab) => tab.tab_id && !before.has(tab.tab_id) && tab.label === label,
        );
        if (candidates.length === 1) {
          const tabId = candidates[0]!.tab_id!;
          const panes = await this.call<PaneListPayload>(
            "pane list",
            ["pane", "list", "--workspace", workspaceId],
            { timeoutMs: 10_000 },
          );
          const pane = (panes.panes ?? []).find((item) => item.tab_id === tabId && item.pane_id);
          if (pane?.pane_id) return { tabId, paneId: pane.pane_id };
        }
      } catch {
        // Retry a short bounded window: the server mutation may outlive the CLI.
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
    return undefined;
  }

  async waitForAvailableShell(
    paneId: string,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    let delayMs = 50;
    let lastState = "process info unavailable";

    for (;;) {
      options.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HerdrCommandError(
          "pane shell readiness",
          `pane ${paneId} did not become an available shell within ${timeoutMs}ms (${lastState})`,
        );
      }

      try {
        const result = await this.call<PaneProcessInfoPayload>(
          "pane process-info",
          ["pane", "process-info", "--pane", paneId],
          { signal: options.signal, timeoutMs: Math.min(2_000, remaining) },
        );
        const info = result.process_info;
        const shellPid = info?.shell_pid;
        const foregroundGroup = info?.foreground_process_group_id;
        lastState = `shell_pid=${shellPid ?? "unknown"}, foreground_process_group_id=${foregroundGroup ?? "unknown"}`;
        if (typeof shellPid === "number" && shellPid > 0 && foregroundGroup === shellPid) return;
      } catch (error) {
        options.signal?.throwIfAborted();
        lastState = error instanceof Error ? error.message : String(error);
      }

      const waitMs = Math.min(delayMs, Math.max(0, deadline - Date.now()));
      if (waitMs <= 0) continue;
      await abortableDelay(waitMs, options.signal);
      delayMs = Math.min(delayMs * 2, 500);
    }
  }

  async startAgentWhenReady(input: {
    paneId: string;
    name: string;
    piArgs: string[];
    signal?: AbortSignal;
    startupTimeoutMs?: number;
    shellTimeoutMs?: number;
  }): Promise<HerdrAgentSnapshot> {
    const shellTimeoutMs = input.shellTimeoutMs ?? 10_000;
    const deadline = Date.now() + shellTimeoutMs;
    let retryDelayMs = 100;

    for (;;) {
      input.signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new HerdrCommandError(
          "pane shell readiness",
          `pane ${input.paneId} did not remain available long enough to start an agent within ${shellTimeoutMs}ms`,
        );
      }
      await this.waitForAvailableShell(input.paneId, { signal: input.signal, timeoutMs: remaining });
      try {
        return await this.startAgent({
          paneId: input.paneId,
          name: input.name,
          piArgs: input.piArgs,
          signal: input.signal,
          timeoutMs: input.startupTimeoutMs,
        });
      } catch (error) {
        if (!isShellBusyError(error)) throw error;
        const waitMs = Math.min(retryDelayMs, Math.max(0, deadline - Date.now()));
        if (waitMs <= 0) throw error;
        await abortableDelay(waitMs, input.signal);
        retryDelayMs = Math.min(retryDelayMs * 2, 1_000);
      }
    }
  }

  async startAgent(input: {
    paneId: string;
    name: string;
    piArgs: string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<HerdrAgentSnapshot> {
    const startupTimeout = input.timeoutMs ?? 30_000;
    const result = await this.call<AgentPayload>(
      "agent start",
      [
        "agent",
        "start",
        input.name,
        "--kind",
        "pi",
        "--pane",
        input.paneId,
        "--timeout",
        String(startupTimeout),
        "--",
        ...input.piArgs,
      ],
      { signal: input.signal, timeoutMs: startupTimeout + 5_000 },
    );
    if (!result.agent) throw new HerdrCommandError("agent start", "response omitted agent");
    return result.agent;
  }

  async promptAgent(input: {
    paneId: string;
    prompt: string;
    timeoutMs: number;
    signal?: AbortSignal;
    wait?: boolean;
  }): Promise<HerdrAgentSnapshot> {
    const args = ["agent", "prompt", input.paneId, input.prompt];
    if (input.wait !== false) args.push("--wait", "--timeout", String(input.timeoutMs));
    const result = await this.call<AgentPayload>(
      "agent prompt",
      args,
      { signal: input.signal, timeoutMs: input.wait === false ? 10_000 : input.timeoutMs + 5_000 },
    );
    if (!result.agent) throw new HerdrCommandError("agent prompt", "response omitted agent");
    return result.agent;
  }

  async getAgent(paneId: string, signal?: AbortSignal): Promise<HerdrAgentSnapshot> {
    const result = await this.call<AgentPayload>("agent get", ["agent", "get", paneId], {
      signal,
      timeoutMs: 10_000,
    });
    if (!result.agent) throw new HerdrCommandError("agent get", "response omitted agent");
    return result.agent;
  }

  async getTab(tabId: string, signal?: AbortSignal): Promise<HerdrTab> {
    const result = await this.call<TabPayload>("tab get", ["tab", "get", tabId], { signal, timeoutMs: 5_000 });
    if (!result.tab?.tab_id) throw new HerdrCommandError("tab get", "response omitted tab_id");
    return { tabId: result.tab.tab_id, label: result.tab.label ?? "" };
  }

  async renameTab(tabId: string, label: string, signal?: AbortSignal): Promise<void> {
    await this.call<TabPayload>("tab rename", ["tab", "rename", tabId, label], { signal, timeoutMs: 5_000 });
  }

  async closeTab(tabId: string, signal?: AbortSignal): Promise<void> {
    await this.call<unknown>("tab close", ["tab", "close", tabId], { signal, timeoutMs: 10_000 });
  }
}
