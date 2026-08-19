import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runProcess, type ProcessRunner } from "./process.ts";
import type { ChildResultFile } from "./types.ts";

export const CHILD_GATE_ENV = "HERDR_SUBAGENT";
export const CHILD_RESULT_ENV = "HERDR_SUBAGENT_RESULT_FILE";
export const CHILD_SILENT_ENV = "HERDR_SUBAGENT_SILENT";

const SILENT_AGENT = "pi";
const SILENT_AGENT_SOURCE = "herdr-pi-subagents:silent";

export const CHILD_INSTRUCTIONS = `You are an isolated subagent working for a parent Pi session.
Complete only the delegated task. Work autonomously and do not delegate to more agents.
Your final response is the result collected by the parent. Make it a concise, self-contained summary with:
- the answer or key findings;
- files changed, if any;
- validation performed;
- remaining risks or blockers.
Do not include greetings or ask the parent follow-up questions. If blocked, explain exactly why in the final response.`;

interface MessageLike {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  usage?: unknown;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function extractLastAssistant(entries: readonly unknown[]): MessageLike | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: string; message?: MessageLike } | undefined;
    const message = entry?.type === "message" ? entry.message : (entry as MessageLike | undefined);
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

export function extractLastAssistantText(entries: readonly unknown[]): string {
  const message = extractLastAssistant(entries);
  return message ? textFromContent(message.content) : "";
}

export function extractAssistantFromJsonEvent(event: unknown): MessageLike | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const value = event as { type?: string; message?: MessageLike };
  if (value.type !== "message_end" || value.message?.role !== "assistant") return undefined;
  return value.message;
}

export async function writeChildResult(path: string, result: ChildResultFile): Promise<void> {
  if (!isAbsolute(path)) throw new Error(`${CHILD_RESULT_ENV} must be an absolute path`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(result)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function readChildResult(
  path: string,
  options: { attempts?: number; delayMs?: number; notBeforeMs?: number; signal?: AbortSignal } = {},
): Promise<ChildResultFile | undefined> {
  const attempts = options.attempts ?? 20;
  const delayMs = options.delayMs ?? 100;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (
        isChildResultFile(parsed) &&
        (options.notBeforeMs === undefined || Date.parse(parsed.writtenAt) >= options.notBeforeMs)
      ) {
        return parsed;
      }
    } catch {
      // The child hook may settle just after Herdr reports the idle transition.
    }
    if (attempt + 1 < attempts) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, delayMs);
        const abort = () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          reject(options.signal?.reason ?? new Error("Aborted"));
        };
        options.signal?.addEventListener("abort", abort, { once: true });
      });
    }
  }
  return undefined;
}

function isChildResultFile(value: unknown): value is ChildResultFile {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<ChildResultFile>;
  return (
    result.version === 1 &&
    (result.status === "completed" || result.status === "failed") &&
    typeof result.summary === "string" &&
    typeof result.writtenAt === "string" &&
    (result.error === undefined || typeof result.error === "string")
  );
}

export async function removeResultDirectory(path: string): Promise<void> {
  await rm(dirname(path), { recursive: true, force: true });
}

function resultFromContext(ctx: ExtensionContext): ChildResultFile {
  const assistant = extractLastAssistant(ctx.sessionManager.getBranch());
  const summary = assistant ? textFromContent(assistant.content) : "";
  const failed = assistant?.stopReason === "error" || assistant?.stopReason === "aborted" || !summary;
  return {
    version: 1,
    status: failed ? "failed" : "completed",
    summary,
    ...(assistant?.errorMessage ? { error: assistant.errorMessage } : {}),
    ...(assistant?.usage ? { usage: assistant.usage } : {}),
    writtenAt: new Date().toISOString(),
  };
}

interface ChildModeOptions {
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
}

class SilentHerdrLifecycle {
  private active = false;
  private reportSeq = Date.now() * 1_000;

  constructor(
    private readonly paneId: string,
    private readonly binary: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly runner: ProcessRunner,
  ) {}

  private async call(args: string[]): Promise<boolean> {
    try {
      const output = await this.runner({
        command: this.binary,
        args,
        env: { ...this.env },
        timeoutMs: 2_000,
      });
      return output.code === 0 && !output.aborted && !output.timedOut && !output.spawnError;
    } catch {
      return false;
    }
  }

  private stateArgs(state: "working" | "unknown"): string[] {
    this.reportSeq += 1;
    return [
      "pane",
      "report-agent",
      this.paneId,
      "--source",
      SILENT_AGENT_SOURCE,
      "--agent",
      SILENT_AGENT,
      "--state",
      state,
      "--seq",
      String(this.reportSeq),
    ];
  }

  async working(): Promise<void> {
    if (await this.call(this.stateArgs("working"))) this.active = true;
  }

  async settled(): Promise<void> {
    if (!this.active) return;
    // Herdr only emits completion sound for the working -> idle/done path.
    // The parent collects the result file directly, so a supervised child can
    // settle as unknown without generating human-attention noise.
    if (await this.call(this.stateArgs("unknown"))) return;

    // Never leave a child permanently under stale lifecycle authority if the
    // final report fails. Native Pi detection is the safe fallback.
    this.active = false;
    this.reportSeq += 1;
    await this.call([
      "pane",
      "release-agent",
      this.paneId,
      "--source",
      SILENT_AGENT_SOURCE,
      "--agent",
      SILENT_AGENT,
      "--seq",
      String(this.reportSeq),
    ]);
    process.stderr.write("herdr-pi-subagents: silent lifecycle report failed; restored native Herdr detection\n");
  }
}

function createSilentLifecycle(options: ChildModeOptions): SilentHerdrLifecycle | undefined {
  const env = options.env ?? process.env;
  if (env[CHILD_SILENT_ENV] !== "1" || env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) return undefined;
  return new SilentHerdrLifecycle(
    env.HERDR_PANE_ID,
    env.HERDR_BIN || env.HERDR_BIN_PATH || "herdr",
    env,
    options.runner ?? runProcess,
  );
}

export function registerChildMode(
  pi: ExtensionAPI,
  resultPath: string | undefined,
  options: ChildModeOptions = {},
): void {
  const silentLifecycle = createSilentLifecycle(options);

  pi.on("before_agent_start", async (event) => {
    await silentLifecycle?.working();
    return {
      systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${CHILD_INSTRUCTIONS}` : CHILD_INSTRUCTIONS,
    };
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (resultPath) {
      try {
        await writeChildResult(resultPath, resultFromContext(ctx));
      } catch (error) {
        process.stderr.write(
          `herdr-pi-subagents: failed to write child result: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
    await silentLifecycle?.settled();
  });
}
