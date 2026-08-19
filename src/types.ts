export const MAX_TASKS = 8;
export const DEFAULT_CONCURRENCY = 4;
export const MAX_SUMMARY_BYTES = 16 * 1024;

export type SubagentEffort = "low" | "medium" | "high";

export interface SubagentTask {
  task: string;
  label?: string;
  cwd?: string;
  effort?: SubagentEffort;
}

export type ChildBackend = "herdr" | "local";
export type ChildStatus = "queued" | "starting" | "working" | "completed" | "failed" | "aborted" | "timed_out";

export interface ChildResultFile {
  version: 1;
  status: "completed" | "failed";
  summary: string;
  error?: string;
  usage?: unknown;
  writtenAt: string;
}

export interface ChildResult {
  index: number;
  label: string;
  task: string;
  cwd: string;
  backend: ChildBackend;
  status: Exclude<ChildStatus, "queued" | "starting" | "working">;
  summary: string;
  error?: string;
  paneId?: string;
  tabId?: string;
  agentName?: string;
  truncated?: boolean;
}

export interface ChildProgress {
  index: number;
  label: string;
  backend: ChildBackend;
  status: ChildStatus;
  paneId?: string;
  tabId?: string;
}

export interface FleetEntry {
  tabId: string;
  paneId: string;
  agentName: string;
  label: string;
  cwd: string;
  status: "starting" | "working" | "completed" | "failed";
  reusable: boolean;
  createdAt: number;
}

export interface DispatchContext {
  cwd: string;
  model?: string;
  thinkingLevel?: string;
}

export interface RunBatchOptions {
  concurrency: number;
  timeoutMs: number;
  keepTabs: boolean;
}

export interface BatchResult {
  backend: ChildBackend;
  results: ChildResult[];
}
