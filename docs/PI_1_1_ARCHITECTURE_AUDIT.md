# Pi 1.1 architecture and event-hook audit

Audited **2026-10-08**, comparing this extension's pinned **Pi 0.80.6** with **Pi 1.1.0**. Both the
installed host and npm's `latest` tag were 1.1.0. This is an audit, not a runtime migration;
production code and dependency metadata are unchanged.

## Executive finding

**Yes: Pi now provides public integration points that eliminate some workarounds and enable new
optional audio cues.** The strongest immediate improvement is `agent_settled.aborted`, introduced in
**1.1.0**, not 1.0.0. It provides explicit run-abort information without inspecting assistant
messages. UI-prompt events also enable a useful “needs your attention” cue.

Most other relevant additions arrived **between 0.80.6 and 1.0**, rather than at the 1.0 boundary.
The extension already uses the right final-completion event: `agent_settled` existed in 0.80.4. None
of its six registered event names were removed or renamed.

## Architecture relevant to this extension

- The agent core executes model turns and tools. `agent_end` ends one low-level run, not necessarily
  all work associated with a submitted prompt.
- `AgentSession` owns retries, recovery, compaction, queued work, and final settlement.
- The extension runner dispatches public hooks and supplies mode-specific `ctx.ui` implementations.
  Extensions still run in-process, with the host's OS permissions; no separate audio/plugin daemon
  is required.
- New `agent_before_settle` handlers can append entries and request continuation. Final audio should
  remain on the notification-only **`agent_settled`**, after that boundary.
- CLI codemode and MCP are built-in extensions. Calls made through `ctx.executeTool()` now flow
  through the tool-event pipeline, including nested calls.
- Lifecycle audio must remain independent from rendering and gated by `ctx.mode === "tui"`. RPC
  having `ctx.hasUI === true` does not make it a local audio-capable terminal.

Current registration in `src/index.ts`: `session_start`, `agent_start`, `tool_execution_end`,
`agent_end`, `agent_settled`, `session_shutdown`. Session-scoped setup and idempotent shutdown still
follow Pi's lifecycle contract.

## Relevant changes, ranked

| Change                                       | Introduced | Audio impact                                                                                                   | Recommendation                                                                |
| -------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `agent_settled.aborted`                      | **1.1.0**  | Explicit run-abort status at final settlement; replaces assistant-message inspection for normal session aborts | **Highest priority**                                                          |
| `ui_prompt_start` / `ui_prompt_end`          | 0.84.4     | Observe blocking extension UI prompts without wrapping other extensions' UI methods                            | Optional “attention needed” cue                                               |
| Nested tool events with `parentToolCallId`   | 0.99.0     | Existing error hook observes child calls, including codemode/MCP calls                                         | Keep hook; explicitly choose nested-error policy                              |
| `tool_execution_end.durationMs`              | **1.1.0**  | Host-measured execution duration without maintaining start-time maps                                           | Optional long-tool cue; unnecessary for current error cue                     |
| `session_compact_failed`                     | 0.84.3     | Dedicated failure/cancellation notification for manual and automatic compaction                                | Optional distinct compaction-failure cue                                      |
| `agent_before_settle`; actionable `turn_end` | 0.87.0     | Extensions can continue work before settlement; boundary includes an outcome                                   | Do not move completion audio here                                             |
| `pi.on()` returns an unsubscribe function    | 0.86.0     | Remove individual registrations dynamically                                                                    | Useful for optional subscriptions; current factory registration remains valid |

### 1. Abort detection: substantially simpler, but choose the policy first

Currently, `src/terminal-outcomes.ts` requires both:

1. A literal raw Escape sequence during the active generation.
2. The final assistant message in `agent_end.messages` having `stopReason === "aborted"`.

It then chooses the abort or settlement cue when `agent_settled` arrives. Pi 1.1.0 adds a required
`aborted: boolean` to that final event.

**What it actually measures:** `AgentSession` emits its `_agentRunAbortRequested` flag.
`session.abort()` sets that flag for an active run. It is reset at the start of the encompassing
run, not each low-level retry. It does not derive the flag from assistant-message contents.

Two migration policies are possible:

- **Any active session abort:** use the final event's flag, retaining the adapter's active-run and
  duplicate-settlement guards. Remove final-message scanning and the `agent_end` subscription used
  solely for that scanning. Raw Escape tracking can also go away. This includes remapped interrupt
  keys and programmatic session aborts, so it changes the existing literal-Escape-only behavior.
- **Literal Escape only:** retain the additive terminal listener and combine same-run Escape
  observation with the final event's flag. Message scanning can still go away. The new field does
  not identify which key, caller, or action requested the abort. The existing listener compares only
  `"\u001b"`, so it also misses Escape encoded by newer terminal protocols; observing bytes alone
  does not prove physical-key provenance or that focused UI actually accepted an interrupt.

**Important limitations:**

- In the current TUI, Escape during retry backoff calls `abortRetry()` directly, and Escape during
  compaction calls `abortCompaction()` directly. Neither sets `_agentRunAbortRequested`.
  Consequently, these operations can be cancelled while final settlement reports `aborted: false`.
  Cover those separately if the product should sound an abort cue for them.
- `aborted: false` is **not a success guarantee**. Exhausted failures can also settle without an
  explicit session abort. Keep the current cue's meaning as “settled,” not “task succeeded.”
- There is no public `agent_aborted` event in the audited API. `agent_before_settle.outcome` offers
  additional information, but is actionable and not the final notification boundary.
- 1.0.x does not have this new field. A migration relying on it should require **Pi >=1.1.0**, or
  retain a tested fallback for older versions. Do not silently treat an absent field as proof of
  normal completion.

### 2. UI prompts: a new “needs attention” capability

The new events contain `reason: "ui_prompt"`, a `kind` of
`select | confirm | input | editor | custom`, and an optional `title`. They observe calls through
supplied extension `ctx.ui` methods. This makes permission prompts and other extension questions
observable without monkey-patching those extensions.

Recommended first scope: emit an optional attention cue on `ui_prompt_start` for `select`,
`confirm`, `input`, and `editor` while agent work is active. Apply the existing local-TUI,
configuration, suppression, and scheduling policies.

Do not interpret these as universal UI-navigation events:

- They do not cover every built-in picker, login screen, notification, or widget.
- The runner uses one depth counter: nested or overlapping prompts collapse into one outer start/end
  pair. There is no prompt ID, originating-extension ID, answer, or cancellation result.
- Events are dispatched asynchronously through microtasks, not awaited as part of showing the UI.
- `custom` has no title. This extension's `/audio:config` screen produces a generic pair, not events
  for its submenu navigation, saves, toggles, or previews. Including `custom` indiscriminately can
  duplicate its existing Settings sounds; start with other kinds or explicitly suppress own UI.
- RPC UI calls can also emit these events. Continue using the TUI gate.

### 3. Tool errors: better visibility without a new subscription

The existing `tool_execution_end` handler already checks `event.isError`, which remains correct.
Since 0.99.0, nested calls emit execution events with `parentToolCallId` and assigned IDs of the
form `<parent>/<n>`. A child error can now request audio even when its caller handles the failure
and ultimately succeeds. A child and its failing outer call can both request audio.

Keep the current scheduler's coalescing and concurrency protections. Decide whether `toolError`
means **any failed tool call** (including nested calls) or only failed top-level tools. For the
latter, filter events whose `parentToolCallId` is present. Do not assume errors can only come from
`read`, `bash`, `edit`, or `write`.

`durationMs` measures `execute()` with a monotonic clock and can be absent when execution did not
run, such as a blocked call. It is not total permission-wait or end-to-end wall time. It is useful
for a future long-tool cue but adds no requirement to current playback.

### 4. Compaction and lifecycle boundaries

`session_compact_failed` exposes `reason: manual | threshold | overflow`, `aborted`, optional
`errorMessage`, `willRetry`, and `fromExtension`. It enables a separate compaction warning without
inferring failure from missing success events or parsing displayed text. Do not map an intentional
cancel automatically to `toolError`.

Implementation caveats: failure can occur before `session_before_compact`, and the audited failure
paths emit `willRetry: false`, including overflow failures. Do not build an exact attempt-pairing or
predicted-retry policy from those events alone.

Since 0.87.0, runs requested from settled handlers are deferred until settled-handler dispatch
finishes. This reduces reentrant `agent_start` surprises. `agent_start` still represents low-level
starts, so the existing multiple-start/final-single-settlement behavior remains appropriate.

## Complete event-name delta

Compared with 0.80.6, the public `ExtensionAPI.on()` overloads add exactly eight event names:

- `agent_before_settle`
- `cache_warming_decision`
- `context_with_system`
- `mcp_servers_change`
- `provider_stream_event`
- `session_compact_failed`
- `ui_prompt_start`
- `ui_prompt_end`

No event names were removed. The cache, context, MCP-configuration, and raw provider-stream hooks
are not needed for current audio. In particular, avoid provider-specific stream parsing for
cancellation when the session-level flag exists. No dedicated global Settings-navigation or built-in
audio-playback API was found in the audited extension surface.

## Compatibility and release work

The current package **declares Pi >=0.80.6 <1.0.0**, both in `package.json` and `README.md`. That
excludes 1.x from claimed support even though the code loads and the tests pass. The real-loader
smoke test shows this declaration is not itself evidence of a load failure.

For a 1.1-native release:

1. Decide whether abort audio means literal Escape or any active session abort.
2. Pass `agent_settled.aborted` into the adapter and remove redundant message inspection.
3. Add tests for normal completion, explicit abort, remapped/programmatic abort policy,
   retry/compaction cancellation, duplicate settlement, retries, and shutdown.
4. Update dev dependencies, compatibility metadata, README, exact metadata assertions in
   `tests/foundation.test.ts`, CI, and `docs/RELEASE_ACCEPTANCE_BASELINE.md` together.
5. Account for **Pi 1.1.0's Node >=22.19.0 requirement**. If dropping old Pi support, align the
   extension's declared Node requirement and CI; retaining old Pi support can retain its older Node
   matrix separately.
6. Treat attention/compaction/long-tool cues as optional feature work: they require configuration,
   event catalog, asset mapping, scheduler policy, and acceptance-test decisions.

Existing `DynamicBorder`, `getAgentDir`, custom-UI callback shape, selected keybinding identifiers,
`theme.fg()`/`bold()`, mode checks, and session startup/shutdown contracts remain usable.
`ctx.ui.onTerminalInput()` already returned a disposer in 0.80.6; that is not a new capability.
Host-provided Pi/TUI dependencies remain correctly declared as wildcard peers.

## Verification performed

- npm registry check: `npm view @earendil-works/pi-coding-agent version dist-tags --json` → 1.1.0.
- Original checkout against Pi 0.80.6: `npm run typecheck` and **144/144 tests passed**.
- TypeScript check with temporary mappings to actual Pi/TUI 1.1.0 declarations: passed.
- Isolated copy of the test inputs, using existing non-host dependencies and actual Pi/TUI 1.1.0
  packages: `npm run typecheck` and **144/144 tests passed**. An initial fixture copy omitted the CI
  file required by one asset test; after including it, the complete suite passed.
- Actual Pi 1.1.0 extension-loader smoke test: `src/index.ts` loaded without errors and registered
  all six hooks and `/audio:config`.

These checks establish API/loader compatibility and preserve existing deterministic behavior. Most
lifecycle tests use injected/mocked host events, so they do **not** validate new live cancellation
or UI-prompt sequences. No real player or model request was launched, and no cross-platform
audibility or production-release certification is claimed.

## Evidence and references

Audited npm artifacts:

- Baseline: `node_modules/@earendil-works/pi-coding-agent`, version 0.80.6.
- Latest:
  `/Users/derekluciani/.nvm/versions/node/v24.18.0/lib/node_modules/@earendil-works/pi-coding-agent`,
  version 1.1.0, with its supplied Pi TUI dependency.

Paths below are relative to the latest coding-agent package; line numbers refer to that installed
artifact, not the moving upstream branch:

| Evidence                                  | Location                                                                                                                                                   |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release provenance                        | `CHANGELOG.md`: 1.1.0 (duration/abort), 0.99.0 (nested calls), 0.87.0 (boundaries), 0.86.0 (unsubscribe), 0.84.4 (UI prompts), 0.84.3 (compaction failure) |
| New settled/UI/tool event fields          | `dist/core/extensions/types.d.ts:773–857`                                                                                                                  |
| Compaction failure fields                 | `dist/core/extensions/types.d.ts:610–622`                                                                                                                  |
| Public event registrations                | `dist/core/extensions/types.d.ts:1163–1203`; baseline counterpart `:840–872`                                                                               |
| Final abort flag emission                 | `dist/core/agent-session.js:684–706`                                                                                                                       |
| Full-run flag reset and continuation      | `dist/core/agent-session.js:1376–1450`                                                                                                                     |
| Explicit session abort                    | `dist/core/agent-session.js:1909–1919`                                                                                                                     |
| Compaction/retry cancellation             | `dist/core/agent-session.js:2298–2300`, `3067–3068`                                                                                                        |
| TUI phase-specific Escape handlers        | `dist/modes/interactive/interactive-mode.js:2974–2977`, `3033–3036`                                                                                        |
| UI wrapping, depth, asynchronous dispatch | `dist/core/extensions/runner.js:354–400`                                                                                                                   |
| Nested execution events                   | `dist/core/nested-tool-calls.js:98–165`                                                                                                                    |
| Compaction-failure emission               | `dist/core/agent-session.js:2271–2289`, `2556–2577`                                                                                                        |

Upstream reading:
[architecture](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/how-pi-works.md),
[extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md),
[public types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts),
[session implementation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/agent-session.ts),
[terminal UI](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/tui.md), and
[notification example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/notify.ts).
These links track upstream `main`; the version-specific findings above come from the audited
artifacts.
