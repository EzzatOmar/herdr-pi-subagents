import { describe, expect, it } from "vitest";
import { parseJsonLine, runProcess } from "../src/process.ts";

describe("process runner", () => {
  it("uses LF-only JSONL framing and preserves Unicode separators", async () => {
    const lines: string[] = [];
    const output = await runProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify({text:'a\\u2028b'})+'\\n'+JSON.stringify({n:2})+'\\n')"],
      onStdoutLine: (line) => lines.push(line),
      timeoutMs: 5_000,
    });

    expect(output.code).toBe(0);
    expect(lines).toHaveLength(2);
    expect(parseJsonLine(lines[0]!)).toEqual({ text: "a\u2028b" });
    expect(parseJsonLine(lines[1]!)).toEqual({ n: 2 });
  });

  it("propagates an already-aborted signal without spawning", async () => {
    const controller = new AbortController();
    controller.abort();
    const output = await runProcess({ command: "does-not-exist", args: [], signal: controller.signal });
    expect(output.aborted).toBe(true);
    expect(output.code).toBe(1);
  });

  it("marks a process that exceeds its deadline", async () => {
    const output = await runProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 20,
    });
    expect(output.timedOut).toBe(true);
    expect(output.code).not.toBe(0);
  });
});
