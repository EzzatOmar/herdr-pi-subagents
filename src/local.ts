import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { ProcessRunner } from "./process.ts";
import { parseJsonLine } from "./process.ts";
import { extractAssistantFromJsonEvent, readChildResult } from "./child.ts";
import type { ChildResultFile } from "./types.ts";

export interface PiInvocation {
  command: string;
  args: string[];
}

export function getPiInvocation(args: string[], env: NodeJS.ProcessEnv = process.env): PiInvocation {
  if (env.HERDR_PI_BINARY) return { command: env.HERDR_PI_BINARY, args };

  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface LocalChildOutput {
  result?: ChildResultFile;
  fallbackSummary: string;
  error?: string;
  aborted: boolean;
  timedOut: boolean;
}

export async function runLocalChild(input: {
  runner: ProcessRunner;
  cwd: string;
  taskPrompt: string;
  resultPath: string;
  extensionPath: string;
  model?: string;
  thinkingLevel?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<LocalChildOutput> {
  const args = ["--mode", "json", "-p", "--no-session", "--extension", input.extensionPath];
  if (input.model) args.push("--model", input.model);
  if (input.thinkingLevel) args.push("--thinking", input.thinkingLevel);
  args.push(input.taskPrompt);

  let lastAssistant = "";
  const invocation = getPiInvocation(args, input.env);
  const output = await input.runner({
    command: invocation.command,
    args: invocation.args,
    cwd: input.cwd,
    env: {
      ...(input.env ?? process.env),
      HERDR_SUBAGENT: "1",
      HERDR_SUBAGENT_RESULT_FILE: input.resultPath,
    },
    signal: input.signal,
    timeoutMs: input.timeoutMs,
    onStdoutLine(line) {
      const message = extractAssistantFromJsonEvent(parseJsonLine(line));
      if (!message) return;
      const content = message.content;
      if (typeof content === "string") lastAssistant = content;
      else if (Array.isArray(content)) {
        lastAssistant = content
          .filter(
            (part): part is { type: "text"; text: string } =>
              typeof part === "object" &&
              part !== null &&
              (part as { type?: unknown }).type === "text" &&
              typeof (part as { text?: unknown }).text === "string",
          )
          .map((part) => part.text)
          .join("\n");
      }
    },
  });

  let result: ChildResultFile | undefined;
  try {
    result = await readChildResult(input.resultPath, {
      attempts: 5,
      delayMs: 50,
      signal: input.signal?.aborted ? undefined : input.signal,
    });
  } catch {
    // Process classification below is more useful than a secondary read abort.
  }

  const diagnostic = output.spawnError || output.stderr.trim() || (output.code !== 0 ? `pi exited with code ${output.code}` : "");
  return {
    result,
    fallbackSummary: lastAssistant.trim(),
    ...(diagnostic ? { error: diagnostic } : {}),
    aborted: output.aborted,
    timedOut: output.timedOut,
  };
}
