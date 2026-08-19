import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const CAPTURE_LIMIT = 256 * 1024;

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  onStdoutLine?: (line: string) => void;
}

export interface ProcessOutput {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  spawnError?: string;
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessOutput>;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= CAPTURE_LIMIT) return next;
  return Buffer.from(next, "utf8").subarray(-CAPTURE_LIMIT).toString("utf8");
}

function attachStrictJsonlReader(
  onLine: (line: string) => void,
): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const drain = () => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      onLine(line);
    }
  };

  return {
    push(chunk) {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      drain();
    },
    end() {
      buffer += decoder.end();
      if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
    },
  };
}

export const runProcess: ProcessRunner = (request) =>
  new Promise((resolve) => {
    if (request.signal?.aborted) {
      resolve({ code: 1, signal: null, stdout: "", stderr: "", aborted: true, timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let aborted = false;
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killStarted = false;

    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const lines = attachStrictJsonlReader((line) => request.onStdoutLine?.(line));

    const kill = () => {
      if (killStarted) return;
      // On POSIX, signal the detached process group even if its leader has
      // exited: descendants can keep inherited stdout/stderr open and prevent
      // ChildProcess "close" from firing.
      if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return;
      killStarted = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        // The process group may already be gone.
      }
      forceKillTimer = setTimeout(() => {
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
          else if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 2_000);
      forceKillTimer.unref();
    };

    const onAbort = () => {
      aborted = true;
      kill();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    // Close the race between the pre-spawn check and listener registration.
    if (request.signal?.aborted) onAbort();

    if (!aborted && request.timeoutMs && request.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      timeoutTimer.unref();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk.toString("utf8"));
      lines.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk.toString("utf8"));
    });

    const finish = (output: ProcessOutput) => {
      if (settled) return;
      settled = true;
      lines.end();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      request.signal?.removeEventListener("abort", onAbort);
      resolve(output);
    };

    child.on("error", (error) => {
      finish({
        code: 1,
        signal: null,
        stdout,
        stderr,
        aborted,
        timedOut,
        spawnError: error.message,
      });
    });
    child.on("close", (code, signal) => {
      finish({ code: code ?? 1, signal, stdout, stderr, aborted, timedOut });
    });
  });

export function parseJsonLine(line: string): unknown | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
