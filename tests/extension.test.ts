import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";

const inheritedChildGate = process.env.HERDR_SUBAGENT;
beforeAll(() => {
  delete process.env.HERDR_SUBAGENT;
});
afterAll(() => {
  if (inheritedChildGate === undefined) delete process.env.HERDR_SUBAGENT;
  else process.env.HERDR_SUBAGENT = inheritedChildGate;
});

describe("extension", () => {
  it("registers one subagent tool in parent mode", () => {
    const registerTool = vi.fn();
    extension({ registerTool } as never);
    expect(registerTool).toHaveBeenCalledTimes(1);
    expect(registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "subagent",
        parameters: expect.any(Object),
        execute: expect.any(Function),
      }),
    );
  });

  it("lists an empty retained fleet without invoking a process", async () => {
    let tool: any;
    extension({ registerTool: (value: unknown) => (tool = value) } as never);
    const setWidget = vi.fn();
    const result = await tool.execute(
      "call",
      { action: "list" },
      undefined,
      undefined,
      { hasUI: true, ui: { setWidget }, cwd: process.cwd() },
    );
    expect(result.content[0].text).toContain("No retained");
    expect(result.details).toMatchObject({ action: "list", fleet: [] });
    expect(setWidget).toHaveBeenCalledWith("herdr-pi-subagents", undefined);
  });

  it("rejects run without tasks", async () => {
    let tool: any;
    extension({ registerTool: (value: unknown) => (tool = value) } as never);
    await expect(
      tool.execute(
        "call",
        { action: "run" },
        undefined,
        undefined,
        { hasUI: false, ui: { setWidget() {} }, cwd: process.cwd() },
      ),
    ).rejects.toThrow("requires at least one task");
  });
});
