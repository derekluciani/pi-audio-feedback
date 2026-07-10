# Pi SFX Extension — PRD & Owner Decision Log

**Status:** Planning — decisions required before implementation  
**Audience:** Extension owner and implementation team  
**Purpose:** Define a supplemental, local audio-notification extension for Pi. This document captures the prior feasibility audit as implementation-ready requirements and the decisions needed from the owner.

---

## 1. Product Summary

Pi should optionally play short, non-blocking sounds to communicate meaningful agent state changes—primarily that Pi has completed its work and is waiting for the user.

This is a **supplemental** notification channel. It must never block Pi, alter agent behavior, replace the TUI, or make routine activity noisy.

### Primary user story

> As a Pi user, when I leave Pi working in the background, I hear a short ping once it has fully finished and is ready for my next input.

### Success criteria

- The user hears one completion sound after Pi is truly idle.
- The feature is opt-in or can be disabled immediately.
- Playback failures never interrupt or delay Pi.
- Routine agent/tool activity does not create an audio storm.

---

## 2. Confirmed Technical Direction

| Area | Decision / fact | Rationale |
|---|---|---|
| Pi integration | Build as a Pi extension | Pi extensions subscribe to lifecycle events and can use Node.js APIs. No Pi core change is needed. |
| Recommended install scope | Global extension: `~/.pi/agent/extensions/` | Audio feedback is normally a personal preference that should work in every project. |
| Completion event | `agent_settled` | This fires only after retries, automatic compaction/retry, and queued follow-ups have finished. |
| Audio mechanism | Spawn a local OS audio player through Node `child_process` | Pi has no native audio/SFX API. Playback must be detached/non-blocking. |
| Default execution mode | TUI only (`ctx.mode === "tui"`) | Prevents unexpected sound in print, JSON, automation, and most headless use. |
| Sound behavior | Short local sound, best effort | A missing player/device or playback failure must be silent from Pi's perspective. |

### Important semantic limitation

`agent_settled` means **Pi is idle**, not **the task objectively succeeded**. The completion sound should therefore be a neutral “ready” ping. Known tool failures can have a separate error sound, but no event alone can reliably determine whether every user goal was achieved.

---

## 3. Scope

### In scope

- Playback of short local sound effects for selected Pi lifecycle events.
- A completion sound when Pi is fully settled and awaiting input.
- Optional start and error sounds.
- User configuration for enablement and selected sound behavior.
- Platform-aware player selection and graceful failure.
- Rate limiting/debouncing and overlap prevention.

### Out of scope for the first release

- Changing Pi’s agent workflow, tool execution, or TUI behavior.
- Streaming audio, speech synthesis, music, or long-running audio.
- Sending notifications to another device or browser client.
- Guaranteeing a sound when the Pi process runs remotely.
- Inferring whether an arbitrary natural-language task was successful.
- A custom audio mixer, audio-device picker, or system Do Not Disturb integration unless explicitly selected below.

---

## 4. Notification Moments and Proposed Defaults

The extension should prioritize events that genuinely require awareness. Events marked **optional** should be disabled by default unless the owner decides otherwise.

| Moment | Pi signal | Proposed default | Recommended cue | Notes |
|---|---|---:|---|---|
| Pi begins an agent run | `agent_start` | Off | subtle tick | A run may start again for retries or continuations; it is not necessarily a new user task. |
| Pi completes all automatic work and waits for input | `agent_settled` | **On** | short ping | Primary feature. Do not use `agent_end`, which may precede retries/follow-ups. |
| A tool execution fails | `tool_execution_end` with `isError: true` | Off | distinct soft error tone | Multiple tools may fail in one run; rate-limit/group these. |
| An individual tool finishes successfully | `tool_execution_end` | Off | optional tick | Usually too noisy, especially in parallel tool mode. |
| A turn completes | `turn_end` | Off | none | A turn is not final completion; Pi may call more tools. |
| Pi asks for user input | no dedicated event | TBD | attention ping | Can be approximated at `agent_settled` by inspecting the final assistant response, but question detection is heuristic and should not be relied upon for MVP. |
| User aborts work | no dedicated documented event | Off / future | cancel cue | Requires local state tracking; completion behavior after abort needs explicit product policy. |
| Extension-driven approval dialog opens | extension-controlled UI call | Future | attention ping | Only possible for dialogs created/controlled by this extension; it cannot universally detect all Pi UI prompts. |
| Session starts/reloads, model changes, compaction | session/model events | Off | none | Not normally worth an audible cue. |

### Noise-control requirement

The extension **MUST NOT** emit sounds for every streamed message, tool update, or normal successful tool call by default. In parallel tool mode, tool completion events can interleave and arrive in completion order.

---

## 5. Owner Decisions Required

Complete the following decisions before implementation. The suggested values define a low-noise MVP but are not binding until approved.

### 5.1 Product and event policy

| ID | Decision needed | Options | Suggested MVP | Owner decision |
|---|---|---|---|---|
| D-01 | Who is this for? | Personal/global use; per-project/team use; distributable public package | Personal/global use | TBD |
| D-02 | Which completion behavior is required? | Completion only; completion + start; completion + start + errors | Completion only | TBD |
| D-03 | Should completion play after an aborted run? | Yes; no; only if final response exists | No / suppress if recognizable | TBD |
| D-04 | Should known tool failures play a different sound? | No; yes, one sound per settled run; yes, per failed tool | No for MVP | TBD |
| D-05 | Should “Pi needs an answer” have a distinct cue? | No; same completion sound; heuristic distinct sound | Same completion sound | TBD |
| D-06 | Are tool-level sounds desired? | Never; configurable; always | Never by default | TBD |
| D-07 | Is audio enabled by default after installation? | Enabled; disabled until opt-in; prompt once | Enabled for completion only, with simple mute control | TBD |

### 5.2 Sound and accessibility policy

| ID | Decision needed | Options | Suggested MVP | Owner decision |
|---|---|---|---|---|
| D-08 | Source of sounds | Bundled assets; OS system sounds; user-provided file paths | Bundled short assets | TBD |
| D-09 | Sound character | Minimal ping; playful/game-like; configurable theme pack | Minimal ping | TBD |
| D-10 | Volume control | OS volume only; extension gain/player option; both | OS volume only initially | TBD |
| D-11 | Repeated completion handling | Play each time; debounce; coalesce into one sound | Debounce/coalesce | TBD |
| D-12 | Accessibility preference | Audio only; audio plus visual status; visual fallback | Audio only; Pi's normal UI remains unchanged | TBD |
| D-13 | Mute/disabling UX | Config file only; slash command; shortcut; all | Slash command plus persisted configuration | TBD |

### 5.3 Platform and deployment policy

| ID | Decision needed | Options | Suggested MVP | Owner decision |
|---|---|---|---|---|
| D-14 | Supported operating systems | macOS only; macOS + Linux; macOS + Linux + Windows | Declare macOS only unless portability is required | TBD |
| D-15 | Linux audio backend(s) | none; `paplay`; `aplay`; configurable fallback chain | Not in macOS-only MVP | TBD |
| D-16 | Windows support | none; PowerShell/.NET; packaged player | Not in macOS-only MVP | TBD |
| D-17 | Remote/RPC policy | Do not play; play on Pi host; client integration later | TUI/local host only; do not promise remote-client audio | TBD |
| D-18 | Distribution format | Single local `.ts`; extension directory/package; published Pi package | Single local `.ts` for MVP | TBD |

### 5.4 Configuration and data policy

| ID | Decision needed | Options | Suggested MVP | Owner decision |
|---|---|---|---|---|
| D-19 | Configuration location | Global user config; project config; environment/CLI flags; combination | Global user config | TBD |
| D-20 | Project-specific settings | Disallow; allow only in trusted projects; always allow | Disallow for MVP | TBD |
| D-21 | Persist runtime toggles | No; current session only; persist across sessions | Persist across sessions | TBD |
| D-22 | Custom file paths | No; allow absolute files; allow arbitrary commands | Allow files only if needed; never arbitrary commands | TBD |
| D-23 | Telemetry/logging | None; local debug log; usage telemetry | None; optional local debug logging | TBD |

---

## 6. Functional Requirements

### FR-1: Completion notification

1. When enabled and Pi emits `agent_settled`, the extension **MUST** attempt one completion cue.
2. The cue **MUST NOT** fire at `agent_end` in place of `agent_settled`.
3. It **MUST** be non-blocking: Pi may continue its event processing without waiting for the audio player to exit.
4. It **MUST** run only in configured modes; the recommended default is `ctx.mode === "tui"`.

### FR-2: Optional event notifications

1. Start and error notifications **MUST** be independently configurable if included.
2. An error notification **MUST** use `tool_execution_end.isError === true`; it must not inspect or modify tool execution.
3. Tool and turn sounds **MUST** remain disabled by default.

### FR-3: Controls and persistence

1. The extension **MUST** provide a way to enable/disable all sounds without editing source code.
2. The extension **SHOULD** provide separate event toggles and a sound-selection setting if more than one cue is implemented.
3. Configuration errors **MUST** fall back safely to quiet defaults or documented defaults and must not crash Pi.
4. The configuration location and persistence behavior must follow D-19 through D-21.

### FR-4: Playback behavior

1. Playback **MUST** use an argument-array process invocation, not shell-interpolated command text.
2. Player stdout/stderr **MUST NOT** corrupt Pi's TUI or JSON output.
3. A missing player, unavailable audio device, invalid asset, or child-process error **MUST NOT** throw from the Pi event handler or degrade agent execution.
4. The extension **MUST** avoid overlapping sound storms. Exact debounce/grouping policy is defined by D-11.
5. Sounds **SHOULD** be short (target: under one second for the completion cue).

### FR-5: Lifecycle safety

1. The extension factory **MUST NOT** start persistent timers, watchers, sockets, or audio-manager processes.
2. Any session-scoped resources must start in `session_start` or on demand.
3. The extension **MUST** clean up timers and tracked child processes in `session_shutdown`, including reload, quit, new, resume, and fork flows.
4. Handler errors must be caught locally where practical; Pi logs extension errors and continues, but the feature must not rely on that safety net.

---

## 7. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Reliability | Audio is best-effort only. A playback failure must never block a tool, a model request, or final settlement. |
| Performance | Event handling should be effectively immediate; no audio command is awaited on the agent lifecycle path. |
| Noise | Default configuration produces no more than one sound for a normal completed user request. |
| Security | The extension runs with full user permissions. It must use trusted bundled assets or validated paths and must not execute owner-configurable shell strings. |
| Privacy | No network calls, telemetry, recordings, or task-content transmission unless separately approved. |
| Compatibility | The extension must tolerate Pi reload and missing platform players. Unsupported environments should silently disable playback or emit an optional local diagnostic. |
| Maintainability | Platform playback adapters and event policy should be isolated so support can expand without changing core notification logic. |

---

## 8. Platform Constraints

Pi does not provide an audio abstraction. The extension will invoke a player available on the host that runs Pi.

| Environment | Likely approach | Constraint |
|---|---|---|
| macOS | `afplay <sound-file>` | Straightforward local baseline. |
| Linux | `paplay`, `aplay`, or a configured player | Audio stacks and installed players differ by distribution. |
| Windows | PowerShell/.NET or a dedicated player | Must be tested separately; Windows Terminal/WSL may run audio on a different host. |
| SSH/remote Pi | Host-side player only | The sound occurs on the remote host, not automatically on the local terminal machine. |
| Pi RPC client | No extension audio protocol | A client-side feature/integration would be required for local-client sound. |
| Pi JSON/print/CI | Extension still runs | Default TUI-only gating avoids unexpected audio and output pollution. |

---

## 9. Technical Event Model

```text
user prompt
  -> agent_start              (optional start cue)
  -> one or more turns
       -> zero or more tools  (optional error cue on failed tool end)
  -> agent_end                (NOT final enough for completion cue)
  -> agent_settled            (primary completion/ready cue)
```

Pi can automatically retry, compact/retry, or process queued follow-ups after `agent_end`. `agent_settled` is the correct lifecycle boundary for the “ready” sound.

In parallel tool mode, starts are source-ordered but tool updates and ends can interleave; ends arrive in completion order. Any per-tool audio policy therefore needs a debounce/grouping rule.

---

## 10. Acceptance Criteria for the MVP

The implementation phase is ready to complete when all applicable criteria below pass.

1. A locally run TUI session produces exactly one completion ping after a normal prompt finishes and Pi becomes idle.
2. A run with multiple turns/tools still produces no completion ping until final `agent_settled`.
3. Completion playback does not wait for the player process, delay Pi, or add text to the TUI/stdout.
4. Disabling the extension's audio setting prevents all playback immediately or by the documented configuration reload behavior.
5. Missing/unavailable audio playback exits safely without an uncaught extension error or disruption to Pi.
6. In JSON, print, and configured non-TUI modes, no audio is played by default.
7. Reloading or replacing a Pi session does not leave timers or child processes that cause duplicate later sounds.
8. If error notifications are approved, simultaneous/multiple failed tools follow the selected grouping rule and do not produce an uncontrolled burst.
9. The supported OS/backend matrix selected in D-14 through D-16 is manually verified.

---

## 11. Implementation Inputs Still Needed

Implementation should not begin until these are answered at minimum:

- D-01: intended audience/distribution scope
- D-02: event set for MVP
- D-07: default enablement policy
- D-08: asset source
- D-11: debounce/overlap policy
- D-13: user control mechanism
- D-14 through D-17: support and remote-use policy
- D-19 and D-21: configuration location and persistence

Recommended low-risk MVP decision set: **global personal extension; macOS only; TUI only; enabled completion ping only; bundled short asset; persisted global mute toggle; 1–2 second completion debounce; no per-tool/error sounds; no remote/RPC guarantee; no telemetry.**

---

## 12. Reference Audit Sources

- Pi extension lifecycle and event semantics: `docs/extensions.md`, especially **Agent Events**, **Tool Events**, **Long-lived resources and shutdown**, and **Mode Behavior**.
- Example completion notification: `examples/extensions/notify.ts`. Its use of `agent_end` is suitable for a basic notification example, but this extension should use `agent_settled` for true final completion.
- Extension event type definitions: `dist/core/extensions/types.d.ts` (`AgentEndEvent`, `AgentSettledEvent`, `ToolExecutionEndEvent`).

