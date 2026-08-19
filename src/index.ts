import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { CHILD_GATE_ENV, CHILD_RESULT_ENV, registerChildMode } from "./child.ts";
import { SubagentOrchestrator } from "./orchestrator.ts";
import {
  DEFAULT_CONCURRENCY,
  MAX_TASKS,
  type BatchResult,
  type ChildProgress,
  type FleetEntry,
} from "./types.ts";

const TaskSchema = Type.Object({
  task: Type.String({ minLength: 1, maxLength: 50_000, description: "Focused task for this child" }),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Herdr tab label" })),
  cwd: Type.Optional(Type.String({ minLength: 1, description: "Child cwd; defaults to the parent cwd" })),
  effort: Type.Optional(
    StringEnum(["low", "medium", "high"] as const, {
      description: "Child thinking effort; defaults to the parent's current thinking level",
    }),
  ),
});

const SubagentSchema = Type.Object({
  action: StringEnum(["run", "prompt", "list", "close"] as const, {
    description: "run a batch, prompt a retained child, list retained Herdr tabs, or close retained tabs",
  }),
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      minItems: 1,
      maxItems: MAX_TASKS,
      description: "Tasks to run concurrently (action=run)",
    }),
  ),
  concurrency: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_TASKS, description: `Concurrent children; default ${DEFAULT_CONCURRENCY}` }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 10, maximum: 3_600, description: "Per-child deadline; default 900 seconds" }),
  ),
  keepTabs: Type.Optional(
    Type.Boolean({ description: "Keep successful Herdr tabs for inspection; default true" }),
  ),
  tabId: Type.Optional(
    Type.String({ minLength: 1, description: "Owned reusable Herdr tab to prompt (action=prompt)" }),
  ),
  prompt: Type.Optional(
    Type.String({ minLength: 1, maxLength: 50_000, description: "Follow-up assignment (action=prompt)" }),
  ),
  tabIds: Type.Optional(
    Type.Array(Type.String(), { maxItems: MAX_TASKS, description: "Owned tab ids to close; omit to close all" }),
  ),
});

export type SubagentParams = Static<typeof SubagentSchema>;

interface ToolDetails {
  action: "run" | "prompt" | "list" | "close";
  batch?: BatchResult;
  promptResult?: BatchResult["results"][number];
  fleet?: FleetEntry[];
  progress?: ChildProgress[];
  closed?: string[];
  errors?: string[];
}

function progressText(progress: ChildProgress[]): string {
  const counts = new Map<string, number>();
  for (const child of progress) counts.set(child.status, (counts.get(child.status) ?? 0) + 1);
  const order = ["queued", "starting", "working", "completed", "failed", "aborted", "timed_out"];
  return order
    .filter((status) => counts.has(status))
    .map((status) => `${counts.get(status)} ${status.replace("_", " ")}`)
    .join(", ");
}

function batchText(batch: BatchResult): string {
  const succeeded = batch.results.filter((result) => result.status === "completed").length;
  const sections = batch.results.map((result) => {
    const location = result.tabId ? ` (tab ${result.tabId})` : "";
    const heading = `### ${result.label} — ${result.status.replace("_", " ")}${location}`;
    const body = result.summary || result.error || "No summary was produced.";
    const error = result.error && result.summary ? `\n\nError: ${result.error}` : "";
    return `${heading}\n\n${body}${error}`;
  });
  return `Subagents (${batch.backend}): ${succeeded}/${batch.results.length} completed\n\n${sections.join("\n\n---\n\n")}`;
}

function promptResultText(result: BatchResult["results"][number]): string {
  const location = result.tabId ? ` (tab ${result.tabId})` : "";
  const body = result.summary || result.error || "No summary was produced.";
  const error = result.error && result.summary ? `\n\nError: ${result.error}` : "";
  return `Subagent follow-up — ${result.status.replace("_", " ")}${location}\n\n### ${result.label}\n\n${body}${error}`;
}

function fleetText(fleet: FleetEntry[]): string {
  if (fleet.length === 0) return "No retained subagent tabs.";
  return [
    `Retained subagent tabs (${fleet.length}):`,
    ...fleet.map((entry) => `- ${entry.label}: ${entry.status}${entry.reusable ? ", reusable" : ""} (${entry.tabId}, ${entry.paneId})`),
  ].join("\n");
}

function updateFleetWidget(ctx: { hasUI: boolean; ui: { setWidget(key: string, value: string[] | undefined): void } }, fleet: FleetEntry[]) {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    "herdr-pi-subagents",
    fleet.length > 0 ? [fleet.map((entry) => `${entry.label}: ${entry.status}`).join(" | ")] : undefined,
  );
}

function validateParams(params: SubagentParams): void {
  if (params.action === "run" && (!params.tasks || params.tasks.length === 0)) {
    throw new Error("subagent action=run requires at least one task.");
  }
  if (params.action === "prompt" && (!params.tabId || !params.prompt)) {
    throw new Error("subagent action=prompt requires tabId and prompt.");
  }
  if (params.action !== "run" && params.tasks?.length) {
    throw new Error(`subagent action=${params.action} does not accept tasks.`);
  }
  if (params.action !== "prompt" && (params.tabId !== undefined || params.prompt !== undefined)) {
    throw new Error(`subagent action=${params.action} does not accept tabId or prompt.`);
  }
  if (params.action !== "close" && params.tabIds?.length) {
    throw new Error(`subagent action=${params.action} does not accept tabIds.`);
  }
}

export default function herdrPiSubagents(pi: ExtensionAPI): void {
  if (process.env[CHILD_GATE_ENV] === "1") {
    registerChildMode(pi, process.env[CHILD_RESULT_ENV]);
    return;
  }

  const orchestrator = new SubagentOrchestrator({ extensionPath: fileURLToPath(import.meta.url) });

  pi.registerTool({
    name: "subagent",
    label: "Subagents",
    description: [
      "Run up to 8 isolated Pi subagents and collect their final summaries.",
      "Under Herdr, every child is a visible no-focus tab in the current workspace; elsewhere each child is a local Pi subprocess.",
      "Each task may set low, medium, or high thinking effort; otherwise it inherits the parent's current level.",
      "Under Herdr, action=prompt continues a retained child's existing session and returns its next summary.",
      "Use action=list or action=close to manage successful Herdr tabs retained after a run.",
    ].join(" "),
    promptSnippet: "Run isolated subagents or continue retained Herdr children and collect their summaries",
    promptGuidelines: [
      "Use subagent action=run for genuinely separable research, review, or implementation tasks that benefit from isolated context.",
      "Put multiple independent tasks in one subagent run call so they execute concurrently and their summaries are collected together.",
      "Set a task's effort to low, medium, or high when it should differ from the parent's thinking level; use medium, not mid.",
      "Subagent children share their selected working directories; do not assign overlapping file edits concurrently.",
      "Under Herdr, successful tabs are retained by default. Use subagent action=prompt with an owned tabId to continue the same child's context and wait for its next summary.",
      "After consuming retained summaries, use subagent action=close with their tabIds, or omit tabIds to close all owned tabs.",
      "Use subagent action=list when you need the current retained fleet. The tool never prompts, lists, or closes tabs it did not create.",
    ],
    parameters: SubagentSchema,

    async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<ToolDetails>> {
      validateParams(params);

      if (params.action === "list") {
        const fleet = orchestrator.listFleet();
        updateFleetWidget(ctx, fleet);
        return { content: [{ type: "text", text: fleetText(fleet) }], details: { action: "list", fleet } };
      }

      if (params.action === "prompt") {
        onUpdate?.({
          content: [{ type: "text", text: `Prompting retained subagent ${params.tabId}...` }],
          details: { action: "prompt" },
        });
        const promptResult = await orchestrator.promptRetained(
          params.tabId!,
          params.prompt!,
          (params.timeoutSeconds ?? 900) * 1_000,
          signal,
        );
        const fleet = orchestrator.listFleet();
        updateFleetWidget(ctx, fleet);
        return {
          content: [{ type: "text", text: promptResultText(promptResult) }],
          details: { action: "prompt", promptResult, fleet },
        };
      }

      if (params.action === "close") {
        const closed = await orchestrator.closeFleet(params.tabIds, signal);
        const fleet = orchestrator.listFleet();
        updateFleetWidget(ctx, fleet);
        const text = [
          `Closed ${closed.closed.length} subagent tab${closed.closed.length === 1 ? "" : "s"}.`,
          ...(closed.errors.length ? [`Errors:\n${closed.errors.map((error) => `- ${error}`).join("\n")}`] : []),
        ].join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: { action: "close", closed: closed.closed, errors: closed.errors, fleet },
        };
      }

      const tasks = params.tasks!;
      const batch = await orchestrator.runBatch(
        _toolCallId,
        tasks,
        {
          cwd: ctx.cwd,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinkingLevel: ctx.thinkingLevel,
        },
        {
          concurrency: params.concurrency ?? Math.min(DEFAULT_CONCURRENCY, tasks.length),
          timeoutMs: (params.timeoutSeconds ?? 900) * 1_000,
          keepTabs: params.keepTabs ?? true,
        },
        signal,
        (progress) => {
          const details: ToolDetails = { action: "run", progress };
          onUpdate?.({ content: [{ type: "text", text: `Subagents: ${progressText(progress)}` }], details });
        },
      );
      const fleet = orchestrator.listFleet();
      updateFleetWidget(ctx, fleet);
      return { content: [{ type: "text", text: batchText(batch) }], details: { action: "run", batch, fleet } };
    },

    renderCall(args, theme) {
      if (args.action === "run") {
        const count = args.tasks?.length ?? 0;
        return new Text(
          `${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `${count} task${count === 1 ? "" : "s"}`)}`,
          0,
          0,
        );
      }
      const action = args.action === "prompt" ? `prompt ${args.tabId ?? ""}`.trim() : args.action;
      return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", action)}`, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as ToolDetails | undefined;
      if (isPartial && details?.progress) {
        let text = theme.fg("warning", `⏳ ${progressText(details.progress)}`);
        if (expanded) {
          text += `\n${details.progress.map((child) => `  ${child.label}: ${child.status}`).join("\n")}`;
        }
        return new Text(text, 0, 0);
      }
      if (details?.promptResult) {
        const child = details.promptResult;
        const color = child.status === "completed" ? "success" : "error";
        let text = theme.fg(color, `${child.status === "completed" ? "✓" : "✗"} ${child.label}`);
        if (expanded) text += `\n${theme.fg("toolOutput", child.summary || child.error || "(no summary)")}`;
        return new Text(text, 0, 0);
      }
      if (details?.batch) {
        const succeeded = details.batch.results.filter((child) => child.status === "completed").length;
        let text = theme.fg(succeeded === details.batch.results.length ? "success" : "warning", `✓ ${succeeded}/${details.batch.results.length} completed`);
        for (const child of details.batch.results) {
          const color = child.status === "completed" ? "success" : "error";
          text += `\n  ${theme.fg(color, child.status === "completed" ? "✓" : "✗")} ${theme.fg("accent", child.label)}`;
          if (expanded) text += `\n${theme.fg("toolOutput", child.summary || child.error || "(no summary)")}`;
        }
        return new Text(text, 0, 0);
      }
      const content = result.content.find((part) => part.type === "text");
      return new Text(content?.type === "text" ? content.text : "", 0, 0);
    },
  });
}
