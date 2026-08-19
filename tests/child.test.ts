import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  extractAssistantFromJsonEvent,
  extractLastAssistantText,
  readChildResult,
  writeChildResult,
} from "../src/child.ts";

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
});
