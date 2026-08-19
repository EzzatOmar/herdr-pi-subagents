import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { SubagentOrchestrator } from "../src/orchestrator.ts";
import type { ProcessOutput, ProcessRunner } from "../src/process.ts";

function output(stdout = "", overrides: Partial<ProcessOutput> = {}): ProcessOutput {
  return {
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    aborted: false,
    timedOut: false,
    ...overrides,
  };
}

const result = (summary: string) => ({
  version: 1 as const,
  status: "completed" as const,
  summary,
  writtenAt: new Date(0).toISOString(),
});

describe("local orchestration", () => {
  it("runs with bounded concurrency and preserves input order", async () => {
    let active = 0;
    let maximum = 0;
    const thinkingLevels = new Map<string, string>();
    const runner: ProcessRunner = async (request) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const path = request.env!.HERDR_SUBAGENT_RESULT_FILE!;
      const task = request.args.at(-1)!;
      thinkingLevels.set(task, request.args[request.args.indexOf("--thinking") + 1]!);
      await new Promise((resolve) => setTimeout(resolve, task.includes("first") ? 30 : 5));
      await writeFile(path, JSON.stringify(result(task.includes("first") ? "summary one" : "summary two")));
      active -= 1;
      return output();
    };
    const orchestrator = new SubagentOrchestrator({
      runner,
      extensionPath: "/extension.ts",
      env: { HERDR_PI_BINARY: "pi-test" },
    });

    const batch = await orchestrator.runBatch(
      "call-1",
      [
        { label: "one", task: "first task", effort: "low" },
        { label: "two", task: "second task" },
      ],
      { cwd: process.cwd(), model: "provider/model", thinkingLevel: "high" },
      { concurrency: 2, timeoutMs: 1_000, keepTabs: true },
    );

    expect(maximum).toBe(2);
    expect(batch.backend).toBe("local");
    expect(batch.results.map((item) => item.label)).toEqual(["one", "two"]);
    expect(batch.results.map((item) => item.summary)).toEqual(["summary one", "summary two"]);
    expect(batch.results.every((item) => item.status === "completed")).toBe(true);
    expect([...thinkingLevels.entries()].find(([prompt]) => prompt.includes("first task"))?.[1]).toBe("low");
    expect([...thinkingLevels.entries()].find(([prompt]) => prompt.includes("second task"))?.[1]).toBe("high");
    expect(orchestrator.listFleet()).toEqual([]);
  });

  it("classifies timed-out local children", async () => {
    const runner: ProcessRunner = async () => output("", { code: 1, timedOut: true });
    const orchestrator = new SubagentOrchestrator({
      runner,
      extensionPath: "/extension.ts",
      env: { HERDR_PI_BINARY: "pi-test" },
    });
    const batch = await orchestrator.runBatch(
      "call-2",
      [{ task: "slow" }],
      { cwd: process.cwd() },
      { concurrency: 1, timeoutMs: 10, keepTabs: false },
    );
    expect(batch.results[0]?.status).toBe("timed_out");
    await expect(orchestrator.promptRetained("missing", "follow up", 1_000)).rejects.toThrow("requires Herdr");
  });
});

describe("Herdr orchestration", () => {
  it("creates one no-focus tab per task, collects summaries, and closes only owned tabs", async () => {
    const calls: string[][] = [];
    const resultPaths = new Map<string, string>();
    const tabs: Array<{ tab_id: string; label: string }> = [];
    let parentLabel = "parent work";
    let tabNumber = 0;
    const runner: ProcessRunner = async (request) => {
      calls.push(request.args);
      const [group, action] = request.args;
      if (group === "tab" && action === "list") {
        return output(JSON.stringify({ result: { tabs } }));
      }
      if (group === "tab" && action === "get") {
        return output(
          JSON.stringify({ result: { tab: { tab_id: request.args[2], label: parentLabel } } }),
        );
      }
      if (group === "tab" && action === "rename") {
        const tabId = request.args[2]!;
        const newLabel = request.args[3]!;
        if (tabId === "w9:parent") parentLabel = newLabel;
        const childTab = tabs.find((tab) => tab.tab_id === tabId);
        if (childTab) childTab.label = newLabel;
        return output(JSON.stringify({ result: { tab: { tab_id: tabId, label: newLabel } } }));
      }
      if (group === "tab" && action === "create") {
        tabNumber += 1;
        const paneId = `w9:p${tabNumber}`;
        const envValues = request.args
          .map((value, index) => (value === "--env" ? request.args[index + 1] : undefined))
          .filter((value): value is string => Boolean(value));
        const resultEnv = envValues.find((value) => value.startsWith("HERDR_SUBAGENT_RESULT_FILE="))!;
        resultPaths.set(paneId, resultEnv.slice(resultEnv.indexOf("=") + 1));
        const tabId = `w9:t${tabNumber}`;
        tabs.push({ tab_id: tabId, label: request.args[request.args.indexOf("--label") + 1]! });
        return output(JSON.stringify({ result: { root_pane: { pane_id: paneId, tab_id: tabId } } }));
      }
      if (group === "pane" && action === "process-info") {
        const paneId = request.args[request.args.indexOf("--pane") + 1]!;
        return output(
          JSON.stringify({
            result: {
              process_info: { pane_id: paneId, shell_pid: 100, foreground_process_group_id: 100 },
            },
          }),
        );
      }
      if (group === "agent" && action === "start") {
        const paneId = request.args[request.args.indexOf("--pane") + 1]!;
        return output(JSON.stringify({ result: { agent: { pane_id: paneId, agent_status: "idle" } } }));
      }
      if (group === "agent" && action === "prompt") {
        const paneId = request.args[2]!;
        if (request.args[3]!.includes("timed follow up")) {
          return output("", { code: 1, timedOut: true });
        }
        const resultPath = resultPaths.get(paneId)!;
        await mkdir(dirname(resultPath), { recursive: true });
        const isFollowUp = request.args[3]!.includes("follow up");
        const summary = isFollowUp ? `follow-up summary for ${paneId}` : `summary for ${paneId}`;
        const writtenAt = isFollowUp ? new Date().toISOString() : new Date(0).toISOString();
        await writeFile(resultPath, JSON.stringify({ ...result(summary), writtenAt }));
        return output(JSON.stringify({ result: { agent: { pane_id: paneId, agent_status: "done" } } }));
      }
      if (group === "tab" && action === "close") {
        const index = tabs.findIndex((tab) => tab.tab_id === request.args[2]);
        if (index >= 0) tabs.splice(index, 1);
        return output(JSON.stringify({ result: { type: "ok" } }));
      }
      throw new Error(`unexpected command: ${request.args.join(" ")}`);
    };
    const orchestrator = new SubagentOrchestrator({
      runner,
      extensionPath: "/extension.ts",
      env: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "w9",
        HERDR_TAB_ID: "w9:parent",
        HERDR_BIN: "herdr-test",
      },
      now: () => 100,
    });

    const batch = await orchestrator.runBatch(
      "call-abc",
      [
        { label: "review", task: "review it", effort: "medium" },
        { label: "tests", task: "test it" },
      ],
      { cwd: process.cwd(), model: "openai/gpt", thinkingLevel: "high" },
      { concurrency: 2, timeoutMs: 1_000, keepTabs: true },
    );

    expect(batch.results.map((item) => item.label)).toEqual(["review", "tests"]);
    for (const item of batch.results) expect(item.summary).toBe(`summary for ${item.paneId}`);
    const reviewChild = batch.results[0]!;
    const testsChild = batch.results[1]!;
    const creates = calls.filter((args) => args[0] === "tab" && args[1] === "create");
    expect(creates).toHaveLength(2);
    for (const args of creates) {
      expect(args).toContain("--no-focus");
      expect(args).toContain("w9");
      expect(args[args.indexOf("--label") + 1]).toMatch(/^⏳ /u);
    }
    const starts = calls.filter((args) => args[0] === "agent" && args[1] === "start");
    const effortFor = (label: string) => {
      const args = starts.find((candidate) => candidate[candidate.indexOf("--name") + 1] === label)!;
      return args[args.indexOf("--thinking") + 1];
    };
    expect(effortFor("review")).toBe("medium");
    expect(effortFor("tests")).toBe("high");
    expect(calls.some((args) => args.join(" ") === "tab rename w9:parent 📋 parent work")).toBe(true);
    expect(calls.some((args) => args.join(" ") === "tab rename w9:parent parent work")).toBe(true);
    expect(calls.some((args) => args.join(" ") === `tab rename ${reviewChild.tabId} ✅ review`)).toBe(true);
    expect(calls.some((args) => args.join(" ") === `tab rename ${testsChild.tabId} ✅ tests`)).toBe(true);
    expect(parentLabel).toBe("parent work");
    expect(orchestrator.listFleet().map((entry) => entry.tabId)).toEqual(
      expect.arrayContaining([reviewChild.tabId, testsChild.tabId]),
    );
    expect(orchestrator.listFleet().every((entry) => entry.reusable)).toBe(true);

    const startCount = starts.length;
    const createCount = creates.length;
    const pendingFollowUp = orchestrator.promptRetained(testsChild.tabId!, "follow up on the tests", 1_000);
    await expect(
      orchestrator.promptRetained(testsChild.tabId!, "overlapping follow up", 1_000),
    ).rejects.toThrow("busy");
    const followUp = await pendingFollowUp;
    expect(followUp).toMatchObject({
      status: "completed",
      summary: `follow-up summary for ${testsChild.paneId}`,
      paneId: testsChild.paneId,
      tabId: testsChild.tabId,
    });
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "start")).toHaveLength(startCount);
    expect(calls.filter((args) => args[0] === "tab" && args[1] === "create")).toHaveLength(createCount);
    expect(calls.filter((args) => args[0] === "agent" && args[1] === "prompt")).toHaveLength(3);
    expect(orchestrator.listFleet().find((entry) => entry.tabId === testsChild.tabId)?.reusable).toBe(true);
    await expect(orchestrator.promptRetained("unowned", "x", 1_000)).rejects.toThrow("not owned");

    const timedOut = await orchestrator.promptRetained(reviewChild.tabId!, "timed follow up", 1_000);
    expect(timedOut.status).toBe("timed_out");
    expect(orchestrator.listFleet().map((entry) => entry.tabId)).toEqual([testsChild.tabId]);
    expect(calls.some((args) => args.join(" ") === `tab close ${reviewChild.tabId}`)).toBe(true);

    const closed = await orchestrator.closeFleet([testsChild.tabId!, "unowned"]);
    expect(closed.closed).toEqual([testsChild.tabId]);
    expect(closed.errors[0]).toContain("not owned");
    expect(orchestrator.listFleet()).toEqual([]);
    expect(calls.some((args) => args.join(" ") === `tab close ${testsChild.tabId}`)).toBe(true);
  });

  it("refuses a hidden fallback when Herdr context is incomplete", async () => {
    const orchestrator = new SubagentOrchestrator({
      runner: async () => output(),
      extensionPath: "/extension.ts",
      env: { HERDR_ENV: "1" },
    });
    await expect(
      orchestrator.runBatch(
        "call",
        [{ task: "x" }],
        { cwd: process.cwd() },
        { concurrency: 1, timeoutMs: 1_000, keepTabs: true },
      ),
    ).rejects.toThrow("HERDR_WORKSPACE_ID");
  });

  it("closes a created tab when shell readiness reaches its deadline", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (request) => {
      calls.push(request.args);
      if (request.args[0] === "tab" && request.args[1] === "list") {
        return output(JSON.stringify({ result: { tabs: [] } }));
      }
      if (request.args[0] === "tab" && request.args[1] === "create") {
        return output(JSON.stringify({ result: { root_pane: { pane_id: "w1:p7", tab_id: "w1:t7" } } }));
      }
      if (request.args[0] === "pane" && request.args[1] === "process-info") {
        return output(
          JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_process_group_id: 101 } } }),
        );
      }
      if (request.args[0] === "tab" && request.args[1] === "close") {
        return output(JSON.stringify({ result: { type: "ok" } }));
      }
      throw new Error(`unexpected: ${request.args.join(" ")}`);
    };
    const orchestrator = new SubagentOrchestrator({
      runner,
      extensionPath: "/extension.ts",
      env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    });
    const batch = await orchestrator.runBatch(
      "call",
      [{ label: "slow shell", task: "x" }],
      { cwd: process.cwd() },
      { concurrency: 1, timeoutMs: 20, keepTabs: true },
    );

    expect(batch.results[0]).toMatchObject({ status: "timed_out", paneId: "w1:p7", tabId: "w1:t7" });
    expect(calls.some((args) => args.join(" ") === "tab close w1:t7")).toBe(true);
    expect(orchestrator.listFleet()).toEqual([]);
  });

  it("retains identifiers when failed-run cleanup also fails", async () => {
    const runner: ProcessRunner = async (request) => {
      if (request.args[0] === "tab" && request.args[1] === "list") {
        return output(JSON.stringify({ result: { tabs: [] } }));
      }
      if (request.args[0] === "tab" && request.args[1] === "create") {
        return output(JSON.stringify({ result: { root_pane: { pane_id: "w1:p9", tab_id: "w1:t9" } } }));
      }
      if (request.args[0] === "pane" && request.args[1] === "process-info") {
        return output(
          JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_process_group_id: 100 } } }),
        );
      }
      if (request.args[0] === "agent" && request.args[1] === "start") {
        return output("", { code: 1, stderr: "harness failed" });
      }
      if (request.args[0] === "tab" && request.args[1] === "close") {
        return output("", { code: 1, stderr: "close failed" });
      }
      throw new Error("unexpected");
    };
    const orchestrator = new SubagentOrchestrator({
      runner,
      extensionPath: "/extension.ts",
      env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    });
    const batch = await orchestrator.runBatch(
      "call",
      [{ label: "broken", task: "x" }],
      { cwd: process.cwd() },
      { concurrency: 1, timeoutMs: 1_000, keepTabs: true },
    );

    expect(batch.results[0]).toMatchObject({ status: "failed", paneId: "w1:p9", tabId: "w1:t9" });
    expect(orchestrator.listFleet()).toEqual([
      expect.objectContaining({ tabId: "w1:t9", paneId: "w1:p9", status: "failed", reusable: false }),
    ]);
  });

  it("closes a half-created tab when prompting fails", async () => {
    const calls: string[][] = [];
    const runner: ProcessRunner = async (request) => {
      calls.push(request.args);
      if (request.args[0] === "tab" && request.args[1] === "list") {
        return output(JSON.stringify({ result: { tabs: [] } }));
      }
      if (request.args[0] === "tab" && request.args[1] === "create") {
        return output(JSON.stringify({ result: { root_pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } }));
      }
      if (request.args[0] === "pane" && request.args[1] === "process-info") {
        return output(
          JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_process_group_id: 100 } } }),
        );
      }
      if (request.args[0] === "agent" && request.args[1] === "start") {
        return output(JSON.stringify({ result: { agent: { pane_id: "w1:p2", agent_status: "idle" } } }));
      }
      if (request.args[0] === "agent" && request.args[1] === "prompt") {
        return output("", {
          code: 1,
          stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "stalled" } }),
        });
      }
      if (request.args[0] === "tab" && request.args[1] === "close") {
        return output(JSON.stringify({ result: { type: "ok" } }));
      }
      throw new Error("unexpected");
    };
    const orchestrator = new SubagentOrchestrator({
      runner,
      extensionPath: "/extension.ts",
      env: { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" },
    });
    const batch = await orchestrator.runBatch(
      "call",
      [{ task: "x" }],
      { cwd: process.cwd() },
      { concurrency: 1, timeoutMs: 1_000, keepTabs: true },
    );

    expect(batch.results[0]?.status).toBe("failed");
    expect(calls.some((args) => args.join(" ") === "tab close w1:t2")).toBe(true);
    expect(orchestrator.listFleet()).toEqual([]);
  });
});
