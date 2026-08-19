import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractAssistantFromJsonEvent,
  extractLastAssistantText,
  readChildResult,
  registerChildMode,
  writeChildResult,
} from "../src/child.ts";
import type { ProcessRunner } from "../src/process.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("child result protocol", () => {
  it("extracts the newest assistant text from session entries", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "new" },
            { type: "text", text: "summary" },
          ],
        },
      },
    ];
    expect(extractLastAssistantText(entries)).toBe("new\nsummary");
  });

  it("does not fall back to stale text when the newest assistant is an error", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "stale success" }] } },
      { type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "failed" } },
    ];
    expect(extractLastAssistantText(entries)).toBe("");
  });

  it("recognizes finalized assistant JSON events", () => {
    expect(
      extractAssistantFromJsonEvent({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    ).toMatchObject({ role: "assistant" });
    expect(extractAssistantFromJsonEvent({ type: "message_update" })).toBeUndefined();
  });

  it("writes and reads an atomic versioned result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-child-test-"));
    dirs.push(dir);
    const path = join(dir, "nested", "result.json");
    const result = {
      version: 1 as const,
      status: "completed" as const,
      summary: "all done",
      writtenAt: new Date(0).toISOString(),
    };

    await writeChildResult(path, result);

    expect(await readChildResult(path, { attempts: 1 })).toEqual(result);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(result);
  });

  it("rejects a valid result older than the requested follow-up", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-child-test-"));
    dirs.push(dir);
    const path = join(dir, "result.json");
    await writeChildResult(path, {
      version: 1,
      status: "completed",
      summary: "stale",
      writtenAt: new Date(0).toISOString(),
    });
    expect(await readChildResult(path, { attempts: 1, notBeforeMs: Date.now() })).toBeUndefined();
  });

  it("rejects malformed result JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-child-test-"));
    dirs.push(dir);
    const path = join(dir, "result.json");
    await writeFile(path, JSON.stringify({ version: 1, status: "completed" }));
    expect(await readChildResult(path, { attempts: 1 })).toBeUndefined();
  });

  it("rejects relative result paths", async () => {
    await expect(
      writeChildResult("relative.json", {
        version: 1,
        status: "completed",
        summary: "x",
        writtenAt: new Date(0).toISOString(),
      }),
    ).rejects.toThrow("absolute path");
  });

  it("uses Herdr's muted child lifecycle and settles only after writing the result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "subagent-child-test-"));
    dirs.push(dir);
    const resultPath = join(dir, "result.json");
    const calls: string[][] = [];
    let resultExistedAtSettle = false;
    const runner: ProcessRunner = async (request) => {
      calls.push(request.args);
      if (request.args[request.args.indexOf("--state") + 1] === "unknown") {
        resultExistedAtSettle = JSON.parse(await readFile(resultPath, "utf8")).summary === "child summary";
      }
      return { code: 0, signal: null, stdout: "{}", stderr: "", aborted: false, timedOut: false };
    };
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerChildMode(
      { on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as never,
      resultPath,
      {
        env: {
          HERDR_ENV: "1",
          HERDR_PANE_ID: "w1:p2",
          HERDR_SUBAGENT_SILENT: "1",
          HERDR_BIN: "herdr-test",
        },
        runner,
      },
    );

    await handlers.get("before_agent_start")!({ systemPrompt: "base" });
    await handlers.get("agent_settled")!({}, {
      sessionManager: {
        getBranch: () => [
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "child summary" }] } },
        ],
      },
    });

    expect(resultExistedAtSettle).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      "pane", "report-agent", "w1:p2", "--source", "herdr-pi-subagents:silent",
      "--agent", "pi", "--state", "working", "--seq", expect.any(String),
    ]);
    expect(calls[1]).toEqual([
      "pane", "report-agent", "w1:p2", "--source", "herdr-pi-subagents:silent",
      "--agent", "pi", "--state", "unknown", "--seq", expect.any(String),
    ]);
  });

  it("releases silent authority when the final lifecycle report fails", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (request) => {
      calls.push(request.args);
      const failedFinalReport =
        request.args[1] === "report-agent" && request.args[request.args.indexOf("--state") + 1] === "unknown";
      return {
        code: failedFinalReport ? 1 : 0,
        signal: null,
        stdout: "{}",
        stderr: failedFinalReport ? "failed" : "",
        aborted: false,
        timedOut: false,
      };
    };
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerChildMode(
      { on: (name: string, handler: (...args: any[]) => unknown) => handlers.set(name, handler) } as never,
      undefined,
      {
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p2", HERDR_SUBAGENT_SILENT: "1" },
        runner,
      },
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await handlers.get("before_agent_start")!({ systemPrompt: "" });
    await handlers.get("agent_settled")!({}, { sessionManager: { getBranch: () => [] } });

    expect(calls.some((args) => args[1] === "release-agent")).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("restored native Herdr detection"));
    stderr.mockRestore();
  });
});
