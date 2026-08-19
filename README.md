# herdr-pi-subagents

A Pi extension for concurrent delegation. A parent can run several isolated Pi agents and receives one collected set of concise summaries.

- **Inside Herdr:** every child runs as a real interactive Pi agent in its own no-focus tab in the parent's current workspace.
- **Outside Herdr:** every child runs as an isolated local Pi subprocess, so delegation still works without tabs.

## Install

From Git:

```sh
pi install git:github.com/EzzatOmar/herdr-pi-subagents
```

For development from this checkout:

```sh
npm install
pi -e ./src/index.ts
```

The package imports Pi's core packages as peers, as required for Pi packages.

## Tool

The extension registers one tool, `subagent`.

### Run and collect a concurrent batch

```json
{
  "action": "run",
  "tasks": [
    { "label": "auth review", "task": "Review authentication code for security defects. Do not edit files." },
    { "label": "test gaps", "task": "Find important missing tests. Do not edit files." }
  ],
  "concurrency": 2,
  "timeoutSeconds": 900,
  "keepTabs": true
}
```

The result contains a section per child, in input order, with status, summary, and Herdr tab identifiers when applicable.

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

For every task, the extension:

1. creates a tab in `$HERDR_WORKSPACE_ID` with the task cwd and final label;
2. passes `--no-focus` so it does not steal the user's focus;
3. polls `herdr pane process-info` until the shell owns the foreground process group;
4. starts Pi through `herdr agent start`, retrying a remaining shell-busy race within the same readiness deadline;
5. submits the task through `herdr agent prompt --wait`;
6. collects the final summary over a private result-file protocol;
7. keeps the successful tab by default for human inspection.

Use `action=close` after consuming the summaries. Set `keepTabs: false` to close successful tabs immediately. Failed, timed-out, and aborted children are closed automatically. If bounded cleanup itself fails, the tab remains in the owned fleet with `failed` status so `list`/`close` can retry it.

When `HERDR_ENV=1`, missing Herdr context or a Herdr command failure is reported rather than silently falling back to hidden processes.

## Child result protocol

Children receive a private result path and this extension explicitly on their Pi command line. In child mode the extension:

- does **not** register `subagent`, preventing accidental recursive fleets;
- appends instructions requesting a concise final summary;
- writes the final assistant response atomically on `agent_settled`.

The parent never scrapes terminal output. For Herdr children, a Pi session transcript is used as a fallback if the result-file write races or fails. Local JSON events are the equivalent fallback outside Herdr.

## Model and working directory

Children inherit the parent's selected `provider/model` and thinking level. Credentials stay in normal Pi auth/configuration and are not placed in prompts.

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
