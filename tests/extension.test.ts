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
    const tool = registerTool.mock.calls[0]![0] as any;
    expect(tool.parameters.properties.action.enum).toEqual(["run", "prompt", "list", "close"]);
    const effortSchema = tool.parameters.properties.tasks.items.properties.effort;
    expect(effortSchema.enum).toEqual(["low", "medium", "high"]);
    expect(effortSchema.description).toContain("thinking effort");
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

  it("rejects prompt without a tab and follow-up", async () => {
    let tool: any;
    extension({ registerTool: (value: unknown) => (tool = value) } as never);
    await expect(
      tool.execute(
        "call",
        { action: "prompt" },
        undefined,
        undefined,
        { hasUI: false, ui: { setWidget() {} }, cwd: process.cwd() },
      ),
    ).rejects.toThrow("requires tabId and prompt");
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
