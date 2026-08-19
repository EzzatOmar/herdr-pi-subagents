# Herdr Pi Subagents — Research and Implementation Plan

This is the living source of truth for the project. Keep research findings, decisions, open questions, implementation steps, and validation status here as work proceeds.

## Goal

Create a distributable Pi extension that lets a parent agent spawn multiple subagents, run them concurrently, and collect concise final summaries. When the parent is running under Herdr, every child must run in its own Herdr tab. The design must also define useful behavior when Herdr is unavailable.

## Inputs

- Repository references: `docs/llm.herdr.md`, `docs/llm.pi.extension.md`, and (where relevant) `docs/llm.pi.sdk.md`.
- Installed Pi documentation and extension examples under the local `@earendil-works/pi-coding-agent` package.
- Reference implementation cloned to `/tmp/herdr-subagents` from <https://github.com/asermax/herdr-subagents>.

## Initial requirements

1. Expose an LLM-callable extension tool for spawning/delegating work.
2. Permit multiple calls in one assistant turn so Pi's parallel tool execution can run children concurrently.
3. Isolate each child in its own agent/session/process.
4. Put each child in a separate Herdr tab when `HERDR_ENV=1` and the Herdr CLI is usable.
5. Wait for child completion and return a collected final summary to the parent tool call.
6. Propagate cancellation, bound waits with timeouts, report failures explicitly, and avoid stealing focus.
7. Keep child agents from recursively spawning an unbounded fleet unless recursion is explicitly designed and bounded.
8. Provide tests for command orchestration, result extraction, concurrency-safe state, cancellation, timeout, and fallback behavior.
9. Package the result as a Pi package with clear installation and development instructions.

## Research checklist

- [x] Clone and inventory `asermax/herdr-subagents`.
- [x] Read the supplied Herdr reference.
- [x] Read the supplied Pi extension reference in full.
- [x] Read the installed Pi extension, TUI, SDK, RPC, and package references needed by the design.
- [x] Study the installed Pi subagent example.
- [x] Study the reference implementation's architecture, protocol, helper, extension, tests, and ADRs.
- [x] Inspect the installed Herdr CLI, live JSON shapes, caller context, and relevant command groups.
- [x] Decide Herdr transport and no-Herdr fallback.
- [x] Decide the child completion/result protocol.
- [x] Record a concrete architecture and file plan below.

## Early observations (not final decisions)

- Pi custom tools receive an `AbortSignal`, support progress updates, and may execute concurrently when emitted as sibling tool calls. A single-spawn tool therefore naturally supports a parent spawning several children in parallel.
- Pi's SDK can run nested in-process `AgentSession`s, while `pi --mode rpc`/`pi -p` provide subprocess isolation. Herdr tabs necessarily imply terminal processes, so a subprocess-oriented child runner may offer a consistent abstraction.
- The reference project uses a helper CLI and a parent/child gate. Its source, tests, and ADRs must be examined before choosing whether to adapt or simplify that design.
- Herdr's installed CLI is the syntax authority. Under Herdr, tabs should be created with no focus, explicit current workspace/cwd, parsed opaque IDs, and agent lifecycle APIs rather than guessed terminal state.
- A robust summary should come through a machine-readable side channel (session/RPC output or an atomic result file), not by scraping an alternate-screen terminal transcript.

## Architecture decisions

### Public surface

Register one LLM-callable tool named `subagent` with three actions:

- `run`: accept a batch of 1–8 `{ task, label?, cwd? }` items, execute up to a bounded concurrency, wait for every child, and return all summaries in input order.
- `list`: show Herdr tabs created and retained by this extension instance.
- `close`: close selected retained tab ids, or all retained tabs when ids are omitted.

A batch is the primary interface because it makes concurrent delegation explicit and gives the parent one collected result. Pi can still execute sibling `subagent` tool calls concurrently. `keepTabs` defaults to true under Herdr so the human can inspect completed children; the parent should call `close` after consuming them.

### Herdr backend

When `HERDR_ENV=1`, require the injected workspace context and use the installed `herdr` CLI as the authority:

1. `herdr tab create --workspace $HERDR_WORKSPACE_ID --cwd ... --label ... --env ... --no-focus`.
2. Parse `root_pane.pane_id` and `root_pane.tab_id`; never derive ids.
3. `herdr agent start <unique-name> --kind pi --pane <id> --timeout ... -- <pi-args>`.
4. `herdr agent prompt <pane-id> <task> --wait --timeout ...`.
5. Collect from the child result protocol, retain or close the tab according to `keepTabs`.

A failed/aborted/timed-out run closes its half-created tab. A Herdr-present failure does not silently fall back, because that would violate the promised visible-tab topology.

### No-Herdr backend

When `HERDR_ENV` is not `1`, spawn one isolated `pi --mode json -p --no-session` subprocess per task. This preserves the extension's delegation capability outside Herdr while documenting that no tabs exist in this mode. Child stdout remains a diagnostic fallback.

### Completion protocol

Do not scrape terminal output. Every child receives:

- `HERDR_SUBAGENT=1`;
- a private `HERDR_SUBAGENT_RESULT_FILE` path under a mode-0700 temp directory;
- this extension explicitly via `--extension`, ensuring the child hook is present in both installed and development runs.

In child mode the extension does not expose the delegation tool (a recursion guard). It appends concise child instructions in `before_agent_start`. On `agent_settled`, it extracts the final assistant text from the child's own session branch and atomically writes a versioned JSON result file with summary/error/usage metadata. The parent retries briefly for write-order races and caps model-visible summary bytes. This combines the reference project's reliable parent-side collection principle with a package-owned machine-readable channel that also works for ephemeral local children.

### Inheritance and isolation

Children inherit the parent's active `provider/model` and thinking level through CLI flags; credentials and normal Pi configuration remain process-level and are never copied into prompts. A task may override the inherited thinking level with `effort: "low" | "medium" | "high"`; the extension translates this directly to Pi's `--thinking` flag for both local and Herdr children (`medium`, not `mid`). Each child has an isolated Pi session/context but shares the selected working directory. Concurrent write tasks can conflict, so tool guidance recommends parallel delegation for independent/research work and requires callers to separate editing scopes. Worktree creation is intentionally out of scope for v1.

### State, UI, and cleanup

- Keep an in-memory fleet map only for tabs this extension created; `list` and `close` never operate on unrelated tabs.
- Stream compact aggregate progress through `onUpdate` and custom tool rendering.
- Forward tool cancellation and per-task deadlines to child processes.
- Leave successfully retained tabs alive across the parent session for human inspection; explicit `close` owns cleanup.
- Cap concurrency (default 4, maximum 8), task count, prompt sizes through schema constraints, and result bytes.

## Concrete file plan

- `src/index.ts` — extension registration, parent/child mode split, schemas, renderers.
- `src/orchestrator.ts` — batch scheduling, fleet state, backend selection, result formatting.
- `src/process.ts` — abortable/timeout-bounded subprocess and strict JSONL helpers.
- `src/herdr.ts` — Herdr CLI adapter and JSON envelope validation.
- `src/local.ts` — headless Pi subprocess adapter.
- `src/child.ts` — child prompt injection and atomic settled-result writer.
- `src/types.ts` — protocol and orchestration types.
- `tests/*.test.ts` — pure protocol/parsing tests plus fake-command backend orchestration tests.
- `package.json`, `tsconfig.json`, `vitest.config.ts` — distributable Pi package and strict tooling.
- `README.md` — install, usage, topology, lifecycle, security, and limitations.

## Implementation status

- [x] Scaffold the package and shared protocol types.
- [x] Implement process execution and result-file helpers with tests.
- [x] Implement child-mode prompt injection/result writing with tests.
- [x] Implement local and Herdr backends behind an injectable runner.
- [x] Implement bounded batch orchestration, fleet list/close, progress, and result caps.
- [x] Add Herdr tab-title status markers for waiting parents and working/completed children.
- [x] Register the tool with explicit prompt guidance and compact/expanded rendering.
- [x] Add explicit bounded shell-readiness polling, residual start retries, and lost-create-response reconciliation for Herdr tabs.
- [x] Run typecheck/tests and fix all failures.
- [x] Perform safe local, one-tab Herdr, and two-tab concurrent Herdr smoke tests; close every test-created tab.
- [x] Finalize README and this work log with validation evidence and limitations.
- [x] Add per-task low/medium/high effort overrides, tests, and documentation.

## Work log

- Created this living document and linked it from root `AGENTS.md` before implementation.
- Cloned the requested reference repository to `/tmp/herdr-subagents` and inventoried its source, ADRs, research, and tests.
- Read the supplied references and the installed Pi extension/TUI/SDK/RPC/package documentation relevant to subprocess agents and extension packaging.
- Studied Pi's bundled `examples/extensions/subagent` implementation: JSON-mode child processes, event parsing, inherited model/thinking, concurrency caps, progress rendering, output caps, and abort propagation.
- Studied the requested reference's helper, extension, protocol, ADRs, research, and representative tests. Key adopted lessons: real Herdr tabs, `--no-focus`, parse opaque ids, wait on agent lifecycle rather than terminal output, bounded spawn cleanup, machine-readable collection, and explicit fleet ownership.
- Verified this development session is Herdr-managed (`HERDR_ENV=1`) and inspected the live `tab`, `agent`, and `pane` command surfaces plus current JSON response shapes. Current caller context is injected through `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, and `HERDR_PANE_ID`.
- Chose and documented the concrete architecture above, then implemented the complete Pi package.
- Added strict process cancellation/timeout handling, LF-only JSONL parsing, process-group termination, atomic versioned child results, result-shape validation, transcript/JSON-event fallback collection, output caps, and a child recursion gate.
- Added Herdr creation serialization and before/after reconciliation: if `tab create` mutates the server but loses its CLI response, the adapter recovers the new opaque tab/pane ids. Cleanup has an independent deadline and failed cleanup remains fleet-owned for retry.
- Fixed a reported four-agent startup race where the original three `agent start` attempts exhausted after only 450 ms. The adapter now polls explicit `pane process-info` state until `shell_pid === foreground_process_group_id`, with 50–500 ms exponential backoff and a 10-second bound (or the shorter configured child timeout). A residual `agent_pane_busy` race retries within the same deadline, and all waits remain abort-aware.
- Added best-effort Herdr title markers: active child tabs use `⏳`, retained successful tabs use `✅`, and failed tabs briefly use `❌` before cleanup. The parent uses `📋` while awaiting a fleet, then restores its exact original label. Restoration checks the current label first so it never overwrites a user's in-flight rename, and reference counting handles overlapping batches.
- Used two real concurrent Herdr child reviewers against the implementation. Their actionable findings (abort races, duplicate kill timers, concurrent close state, failed-cleanup ownership, falsy JSON results, stale assistant extraction, gate validation, and result-file validation) were fixed and regression-tested.
- Validation: `npm run check` passes strict TypeScript and 23 tests across 5 files. Tests cover child protocol, malformed/stale results, strict JSONL, abort/timeout, bounded local concurrency, Herdr no-focus creation, delayed shell readiness beyond the old 450 ms window, readiness-timeout cleanup, result collection, ownership-safe close, missing-context refusal, half-created cleanup, lost-response reconciliation, and extension registration.
- Manual validation: one local child returned its summary; one Herdr child returned its summary and its test tab was closed; two simultaneous Herdr children each ran in their own tabs, returned ordered summaries, and both tabs were closed. After the shell-readiness fix, four simultaneous Herdr children all started, returned the expected summaries, and all four test tabs were closed. A title-marker smoke test observed `📋 1` on the waiting parent and `⏳ status marker smoke` on the active child, followed by restoration to `1` and child completion as `✅ status marker smoke`; the test tab was then closed. A package load smoke test (`pi -e . --list-models ...`) exited successfully, and `npm pack --dry-run` contains only the package runtime, README/license, and this research plan.
- Requested enhancement: allow each task to select low, medium, or high model effort while retaining parent-level inheritance when omitted. The public field is `effort`; Pi's canonical middle level is `medium`, not `mid`.
- Implemented the per-task `effort` schema and dispatch override for both local subprocess and Herdr-tab children. Updated prompt guidance and README examples, and verified explicit overrides plus inherited parent levels in both backends. Validation: `npm run check` passes strict TypeScript and all 23 tests across 5 files.
