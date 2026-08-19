# herdr-pi-subagents

A Pi extension for concurrent delegation. A parent can run several isolated Pi agents and receives one collected set of concise summaries.

- **Inside Herdr:** every child runs as a real interactive Pi agent in its own no-focus tab in the parent's current workspace. Retained children can receive later follow-up prompts while preserving their session context. Tab-title icons distinguish the waiting parent (`📋`), active children (`⏳`), and completed children (`✅`).
- **Outside Herdr:** every child runs as an isolated local Pi subprocess, so delegation still works without tabs.

## Requirements

- Node.js 22 or newer.
- Pi with a configured model and credentials (tested with Pi 0.84.2).
- Herdr is optional. When Pi is launched inside Herdr (tested with Herdr 0.8.0), children appear in separate tabs. Otherwise, the extension uses isolated local Pi subprocesses.

## Install

### User installation

Install directly from GitHub. Pi records the package in `~/.pi/agent/settings.json` and loads it in future sessions:

```sh
pi install git:github.com/EzzatOmar/herdr-pi-subagents
```

For a private repository or an SSH-based GitHub setup:

```sh
pi install git:git@github.com:EzzatOmar/herdr-pi-subagents
```

### Project-local installation

To enable it only for one project, run this from that project. Pi writes the package source to `.pi/settings.json`:

```sh
pi install -l git:github.com/EzzatOmar/herdr-pi-subagents
```

After trusting the project, Pi installs any missing project packages automatically.

### One-off or development use

Run from GitHub without saving the package:

```sh
pi -e git:github.com/EzzatOmar/herdr-pi-subagents
```

Or run a checkout directly:

```sh
git clone git@github.com:EzzatOmar/herdr-pi-subagents.git
cd herdr-pi-subagents
npm install
pi -e ./src/index.ts
```

Update installed Pi packages with `pi update --extensions`. Remove this package with:

```sh
pi remove git:github.com/EzzatOmar/herdr-pi-subagents
```

## Use

The extension registers a `subagent` tool. Start or restart Pi after installation, then ask the parent naturally, for example:

> Delegate repository structure, Git state, test coverage, and extension review to four independent subagents. Run them concurrently, do not edit files, and summarize their findings.

Pi should place independent tasks into one concurrent tool call. You can also instruct it to keep the resulting Herdr tabs open for inspection or close them after collecting the summaries.

### Run and collect a concurrent batch

```json
{
  "action": "run",
  "tasks": [
    { "label": "auth review", "task": "Review authentication code for security defects. Do not edit files.", "effort": "high" },
    { "label": "test gaps", "task": "Find important missing tests. Do not edit files.", "effort": "low" }
  ],
  "concurrency": 2,
  "timeoutSeconds": 900,
  "keepTabs": true
}
```

The result contains a section per child, in input order, with status, summary, and Herdr tab identifiers when applicable.

Run options:

- `tasks`: 1–8 focused child assignments. Each accepts `task`, optional `label`, optional `cwd`, and optional `effort` (`low`, `medium`, or `high`; use `medium`, not `mid`).
- `concurrency`: simultaneous children, default 4 and maximum 8.
- `timeoutSeconds`: per-child deadline, default 900 seconds.
- `keepTabs`: retain successful Herdr tabs for inspection; defaults to `true` and has no effect on the local fallback.

Assign only independent work concurrently. Children have isolated conversation contexts but may share a working directory and filesystem.

### Continue a retained child

Under Herdr, send a follow-up to a successfully retained child by its owned tab id:

```json
{
  "action": "prompt",
  "tabId": "w8:t2",
  "prompt": "Now implement the fixes from your review and run the relevant tests.",
  "timeoutSeconds": 900
}
```

The extension reuses the same Pi agent and conversation context, waits for it to settle, and returns its new summary. It does not create another tab or agent. Follow-ups are allowed only for reusable tabs owned by the current extension instance, and overlapping prompts to the same child are rejected. Local fallback children cannot be continued because their processes exit after their initial task.

### Inspect retained tabs

```json
{ "action": "list" }
```

### Close retained tabs

Close selected tabs:

```json
{ "action": "close", "tabIds": ["w8:t2", "w8:t3"] }
```

Close every tab owned by this extension instance:

```json
{ "action": "close" }
```

The extension never lists or closes unrelated Herdr tabs.

## Herdr lifecycle

While a batch is running, the parent tab is prefixed with `📋`. Its original title is restored when the batch finishes. Restoration is best-effort and does not overwrite a title the user changed while waiting.

For every task, the extension:

1. creates a tab in `$HERDR_WORKSPACE_ID` titled `⏳ <label>` with the task cwd;
2. passes `--no-focus` so it does not steal the user's focus;
3. polls `herdr pane process-info` until the shell owns the foreground process group;
4. starts Pi through `herdr agent start`, retrying a remaining shell-busy race within the same readiness deadline;
5. submits the task through `herdr agent prompt --wait`;
6. collects the final summary over a private result-file protocol;
7. renames a successful tab to `✅ <label>` and keeps it by default for inspection or follow-up work.

For `action=prompt`, the retained tab returns to `⏳` while the same agent handles the follow-up, then to `✅` or `❌` when it settles. An operational follow-up failure, timeout, or abort triggers bounded automatic cleanup because the agent's idle state may be uncertain; if cleanup fails, the tab remains owned with failed status so `close` can retry.

Failed tabs are marked `❌` before automatic cleanup. Title markers are cosmetic and best-effort: a rename failure never changes the task result.

Use `action=close` after consuming the summaries. Set `keepTabs: false` to close successful tabs immediately. Failed, timed-out, and aborted children are closed automatically. If bounded cleanup itself fails, the tab remains in the owned fleet with `failed` status so `list`/`close` can retry it.

When `HERDR_ENV=1`, missing Herdr context or a Herdr command failure is reported rather than silently falling back to hidden processes.

## Child result protocol

Children receive a private result path and this extension explicitly on their Pi command line. In child mode the extension:

- does **not** register `subagent`, preventing accidental recursive fleets;
- appends instructions requesting a concise final summary;
- writes the final assistant response atomically on `agent_settled`.

The parent never scrapes terminal output. For Herdr children, a Pi session transcript is used as a fallback if the result-file write races or fails. Before a retained child receives a follow-up, the parent clears its stale result and collects the next atomic settled result through the same private channel. Local JSON events are the equivalent fallback outside Herdr.

## Model and working directory

Children inherit the parent's selected `provider/model` and thinking level. Set `effort` on an individual task to override the inherited thinking level with `low`, `medium`, or `high`; Pi applies the selected model's thinking capabilities. Credentials stay in normal Pi auth/configuration and are not placed in prompts.

Each child has an isolated context and session, but tasks share their requested working directories. **Do not run overlapping edits concurrently.** Prefer concurrent agents for independent research/review tasks, or assign disjoint files/directories. Automatic worktree creation is not part of v1.

## Limits

- Maximum 8 tasks per call.
- Default concurrency 4.
- Default per-child deadline 15 minutes; configurable from 10 seconds to 1 hour.
- New Herdr panes get up to 10 seconds (bounded by the configured child timeout) to become available shells. Polling uses exponential backoff capped at 500 ms and respects cancellation.
- Each model-visible summary is capped at 16 KiB.
- Retained fleet state is in memory for the current extension instance. After a Pi reload/restart, existing tabs remain visible in Herdr but are no longer owned by `action=list`/`action=close`; close them directly in Herdr if needed.

## Development

```sh
npm install
npm run typecheck
npm test
npm run check
```

The design research and implementation log live in [`docs/research-plan.md`](docs/research-plan.md).
