import { describe, expect, it } from "vitest";
import { HerdrClient } from "../src/herdr.ts";
import type { ProcessRunner } from "../src/process.ts";

describe("Herdr client", () => {
  it("waits beyond the old 450ms retry window for a new pane shell", async () => {
    const startedAt = Date.now();
    let readinessProbes = 0;
    let startCalls = 0;
    const runner: ProcessRunner = async (request) => {
      if (request.args[0] === "pane" && request.args[1] === "process-info") {
        readinessProbes += 1;
        const ready = Date.now() - startedAt >= 550;
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({
            result: {
              process_info: {
                pane_id: "w1:p2",
                shell_pid: 100,
                foreground_process_group_id: ready ? 100 : 101,
              },
            },
          }),
          stderr: "",
          aborted: false,
          timedOut: false,
        };
      }
      if (request.args[0] === "agent" && request.args[1] === "start") {
        startCalls += 1;
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({ result: { agent: { pane_id: "w1:p2", agent_status: "idle" } } }),
          stderr: "",
          aborted: false,
          timedOut: false,
        };
      }
      throw new Error(`unexpected: ${request.args.join(" ")}`);
    };
    const client = new HerdrClient(runner, "herdr-test");

    await expect(
      client.startAgentWhenReady({
        paneId: "w1:p2",
        name: "review",
        piArgs: [],
        shellTimeoutMs: 2_000,
      }),
    ).resolves.toMatchObject({ pane_id: "w1:p2", agent_status: "idle" });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
    expect(readinessProbes).toBeGreaterThan(3);
    expect(startCalls).toBe(1);
  });

  it("cancels while waiting for shell readiness", async () => {
    const runner: ProcessRunner = async () => ({
      code: 0,
      signal: null,
      stdout: JSON.stringify({
        result: { process_info: { pane_id: "w1:p2", shell_pid: 100, foreground_process_group_id: 101 } },
      }),
      stderr: "",
      aborted: false,
      timedOut: false,
    });
    const client = new HerdrClient(runner, "herdr-test");
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("cancelled by test")), 20);

    await expect(
      client.waitForAvailableShell("w1:p2", { signal: controller.signal, timeoutMs: 2_000 }),
    ).rejects.toThrow("cancelled by test");
  });

  it("recovers ids when tab creation succeeds server-side but its CLI response is lost", async () => {
    let listCount = 0;
    const runner: ProcessRunner = async (request) => {
      if (request.args[0] === "tab" && request.args[1] === "list") {
        listCount += 1;
        const tabs = listCount === 1 ? [] : [{ tab_id: "w1:t2", label: "review" }];
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({ result: { tabs } }),
          stderr: "",
          aborted: false,
          timedOut: false,
        };
      }
      if (request.args[0] === "tab" && request.args[1] === "create") {
        return {
          code: 1,
          signal: null,
          stdout: "",
          stderr: "connection lost",
          aborted: false,
          timedOut: false,
        };
      }
      if (request.args[0] === "pane" && request.args[1] === "list") {
        return {
          code: 0,
          signal: null,
          stdout: JSON.stringify({ result: { panes: [{ pane_id: "w1:p2", tab_id: "w1:t2" }] } }),
          stderr: "",
          aborted: false,
          timedOut: false,
        };
      }
      throw new Error(`unexpected: ${request.args.join(" ")}`);
    };
    const client = new HerdrClient(runner, "herdr-test");
    await expect(
      client.createTab({ workspaceId: "w1", cwd: "/tmp", label: "review", env: {} }),
    ).resolves.toEqual({ paneId: "w1:p2", tabId: "w1:t2" });
  });

  it("accepts a successful response whose result is falsy", async () => {
    const runner: ProcessRunner = async () => ({
      code: 0,
      signal: null,
      stdout: JSON.stringify({ result: null }),
      stderr: "",
      aborted: false,
      timedOut: false,
    });
    const client = new HerdrClient(runner, "herdr-test");
    await expect(client.closeTab("w1:t1")).resolves.toBeUndefined();
  });
});
