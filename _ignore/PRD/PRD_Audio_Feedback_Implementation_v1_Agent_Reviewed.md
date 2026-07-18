# Implementation-Readiness Review: Pi Audio Feedback PRD

**Reviewed document:** `PRD_Audio_Feedback_Implementation.md`  
**Review perspective:** Engineer accountable for implementing and releasing the feature without making product or technical assumptions

## Verdict

**No.** The PRD is a strong product and architectural outline, but it is not yet a complete, assumption-free implementation specification. The main blockers are abort detection, remote/CI suppression, scheduler semantics, theme-selection audio behavior, the asset-rendering recipe, Windows playback, and unresolved package compatibility/metadata.

The document also labels itself the “sole source of truth” and says the status is “Ready for owner review,” while several required decisions are deferred to an owner checklist or to implementation-time selection. Those decisions must be incorporated into the normative sections before implementation can reliably begin.

## Blocking questions and required clarifications

### 1. Abort detection is not implementable as specified from the documented public events

Sections 7.1 and FR-1 require recording Esc during an active run and then confirming an aborted final assistant result. Pi has no `agent_aborted` event, and `agent_settled` carries no outcome data. The PRD does not identify:

- Which supported public API captures the configured `app.interrupt` action without replacing or interfering with Pi’s editor.
- Whether the extension must wrap the current editor via `getEditorComponent()` / `setEditorComponent()`, register a potentially conflicting shortcut, or use another mechanism.
- How a wrapped editor remains compatible with other extensions that replace the editor.
- How to honor a user-remapped `app.interrupt` binding rather than literal Esc.
- Which event and exact field constitute “an aborted final assistant result.”
- How to distinguish a user abort from provider cancellation, shutdown, compaction overflow recovery, retry cancellation, tool cancellation, or another extension calling `ctx.abort()`.
- How a run is correlated across `agent_start`, possible retries, `agent_end`, and `agent_settled` when events expose no run identifier.

**Decision needed:** Define an API-supported detection algorithm with exact events, message fields/stop reasons, keybinding behavior, and state transitions. If current public APIs cannot support it reliably, either make abort audio explicitly experimental with a defined heuristic or remove it from MVP.

### 2. “Local-host,” SSH, remote, and CI suppression rules conflict or lack a detection algorithm

Sections 2, 4, 5, and 10 variously state that audio:

- Plays on the computer running Pi.
- Is limited to `ctx.mode === "tui"`.
- Is disabled for “SSH/remote Pi,” “remote-host configurations,” and CI.

A Pi TUI launched in an SSH session still has `ctx.mode === "tui"` and would naturally play audio on the remote host. CI is not a Pi mode either. The PRD gives no reliable public Pi property or environment-variable policy for detecting either condition.

**Questions:**

1. Should a TUI process launched over SSH play on the machine running Pi, or be silent?
2. If silent, which exact signals define remote execution (`SSH_CONNECTION`, `SSH_TTY`, Pi configuration, or something else)?
3. Which exact signals define CI, and what happens if those environment variables are false positives?
4. Does “remote client” refer only to RPC mode, or also to a local TUI controlling remote tool execution?
5. Is mode gating alone acceptable for MVP? If so, remove the broader remote/CI claims.

### 3. Scheduler behavior is not deterministic enough to implement or test

Section 4.2 provides goals but leaves multiple valid, observably different implementations:

- “Pending,” “starting,” “collide,” “under load,” and “already heard” are not defined.
- The queue size, FIFO behavior within equal priority, request expiry, and starvation policy are unspecified.
- It is unclear whether a higher-priority request terminates a currently playing lower-priority child, waits for it, or is dropped. “Does not retroactively stop a cue already heard” does not resolve a cue that has just started but is still playing.
- Completion is ranked above abort, but a confirmed abort is said to replace completion. State precedence and timing need a single normative rule.
- “Other events are queued only if no higher-priority cue is pending/starting” does not say what happens when only an equal- or lower-priority cue is pending or playing.
- Tool-error grouping does not explicitly define the window anchor, boundary behavior at exactly 1,000 ms, or whether a suppressed first request (because another cue is playing) still consumes the group.
- It is unclear whether toggle/theme/config checks occur when a request is enqueued or when it starts. A user can change configuration while a cue waits.
- It is unclear whether child `close`, known WAV duration, or a timer marks playback completion, and whether abnormal child exit advances the queue.

**Decision needed:** Add a scheduler state machine or pseudocode and a decision table covering current playback, pending requests, incoming priority, debounce, config changes, process launch failure, process exit, and shutdown.

### 4. Agent-start semantics across retries and continuations are ambiguous

Section 7 notes that `agentStart` may fire again for retries/continuations. Acceptance criterion 10.1 expects an agent-start cue for a normal request, but does not say whether every low-level `agent_start` must produce a cue or only the first start in a user-visible automatic run.

**Question:** Should retry, auto-compaction retry, steering, and queued follow-up starts each be audible? Define expected cue counts for each flow.

### 5. Theme selection currently appears to request two sounds for one Enter press

Section 6.2 maps Enter in the theme selector to both:

- `settingsOptionSelect`, after persisting the newly selected theme; and
- `settingsThemePreview`, using the selected theme.

Section 10 says selecting a theme previews it. It is unclear whether one Enter press should play two sequential sounds, whether preview replaces option-select, or whether preview is a separate action/key. This also interacts with the no-overlap scheduler.

**Questions:**

1. Is theme selection one action with one preview sound, or two cues?
2. Does merely moving the highlighted theme preview it, or only confirming with Enter?
3. Is the theme persisted before attempting preview? Is it retained if launch fails?
4. Does Esc from the theme submenu preserve the most recently confirmed selection or revert to the theme active when the submenu opened?
5. When `settingsThemePreview` is disabled, does theme selection still occur silently?

### 6. Root-menu action cue behavior is incomplete

The document says “Turn all sounds on” plays a confirmation cue, but does not name the logical event. It does not define the cue sequence for “Turn all sounds off.” Depending on implementation, selection could emit `settingsOptionSelect`, `settingsToggleOn`, `settingsToggleOff`, or nothing.

**Questions:**

- Which exact logical event confirms each root action?
- For “Turn all sounds off,” must a cue play before disabling, analogous to an individual toggle-off?
- Do root actions also emit `settingsOptionSelect`?
- If all sounds are already on/off, does selecting the corresponding action save or play anything?

### 7. Asset sources and deterministic rendering settings are still TBD

Sections 3.1–3.2 require pinned sources and deterministic documented settings, but do not specify them. “Pin the selected sources” and “recorded in build documentation” delegate architecture and audible output decisions to the implementer.

Missing normative details include:

- Exact `@web-kits/audio` package version and exact Core/Retro/Organic/Soft patch source versions or immutable source hashes.
- Exact offline Web Audio implementation/polyfill and version.
- Whether checked-in generated patch modules in `lib/.web-kits` are authoritative inputs or regenerated artifacts. The current repository exports only Core and Retro; Organic and Soft inputs are absent.
- Sample rate, bit depth/encoding, channel count, normalization/clipping policy, leading silence, render duration, effect/reverb tail calculation, fade-out behavior, and filename convention.
- Whether generated WAVs are committed, generated in `prepare`, generated in CI, or all three.
- The reproducibility criterion: byte-identical files, PCM-identical samples, or tolerance-based output.
- Exact required upstream notices and where they appear in the package.

**Decision needed:** Put the complete renderer recipe and immutable input provenance in the PRD or in a named, normative build specification.

### 8. Windows playback is not specified precisely enough

“PowerShell/.NET WAV playback in a spawned process” admits materially different implementations.

**Questions:**

- Which executable is required: Windows PowerShell (`powershell.exe`), PowerShell 7 (`pwsh`), or a fallback chain?
- What exact argument/script strategy is approved, including execution-policy and quoting behavior?
- Should `.NET SoundPlayer.PlaySync()` keep the spawned process alive until completion, or should another API be used?
- How are paths containing spaces, apostrophes, or non-ASCII characters passed without shell interpolation?
- What constitutes “launch failure” for UI notification versus a later playback/device failure that remains silent?
- What process is tracked and terminated at shutdown, and is killing its process tree required?

### 9. Linux fallback semantics are unclear

The document says `paplay`, then `aplay`, but not when fallback occurs.

**Questions:**

- Fall back only when spawning `paplay` returns `ENOENT`, or also when it exits nonzero?
- If `paplay` launches successfully but later fails because no server/device exists, should `aplay` be attempted?
- Is normal `PATH` resolution approved, and does it satisfy “without probing”?
- Does preview failure notify only if neither process can be spawned, or also if both exit nonzero?

### 10. Package identity and compatibility remain unresolved release inputs

Section 3.1 explicitly defers package name/scope, repository, versioning policy, license, supported Pi version, and supported Node version. These affect imports, peer dependencies, engines, CI, README, and the install command itself.

**Questions:**

- Is the canonical npm name exactly `pi-audio-feedback`, and is it unscoped?
- What license applies to package code and generated audio assets?
- What minimum/maximum Pi versions are supported, especially for `agent_settled`, `getAgentDir()`, custom UI, and injected keybindings?
- What Node versions and module format are supported?
- Which Pi-provided imports must be declared as `peerDependencies`?
- What is the prerelease/stable versioning and compatibility policy?

Until answered, `pi install npm:pi-audio-feedback` and “published npm package” cannot be acceptance-tested as written.

## Configuration and persistence concerns

### 11. First-run persistence is contradictory

“First install creates or uses the defaults” can mean either writing a file on startup or using in-memory defaults until the first user change.

**Questions:**

- Exactly when is the file first created?
- If the agent directory does not exist, may the extension create it?
- What file and directory permissions are required?
- If writing fails, should the in-session change remain active, be rolled back, or be reported in the Settings UI?

### 12. Validation and migration behavior needs a complete policy

Only the ideal schema is shown. Define behavior for:

- Missing top-level or event fields.
- Unknown fields and unknown event keys.
- Wrong primitive types and unknown theme names.
- Malformed JSON, empty files, symlinks, and unsupported versions.
- Whether valid fields from a partially invalid file are retained or the entire file resets to defaults.
- Whether a repaired/default configuration overwrites the invalid file automatically.
- The implementation plan’s “schema migration” despite no migration behavior being specified.

### 13. Atomic write and multi-process semantics are underspecified

“Atomically enough” is not testable. Multiple Pi processes may update the same global file.

**Decision needed:** Specify temp-file placement, flush/rename expectations, permissions, cleanup after failure, and concurrency behavior. At minimum, define whether last-writer-wins is accepted and whether each mutation must reload/merge the latest on-disk configuration to avoid lost updates.

### 14. Configuration timing is unspecified

**Questions:**

- Is config loaded once per extension/session, on every cue, or reopened when `/audio:config` starts?
- Do edits made by another running Pi instance become visible without reload?
- On `/reload`, `/new`, `/resume`, and `/fork`, should config be reread?
- If a write succeeds but an immediate cue is pending, does that cue use the old or new theme/toggle state?

## Settings UI questions

### 15. The UI interaction contract needs exact state transitions

The root row “Open root settings screen | command / Enter” is ambiguous: invoking the slash command is not an Enter selection inside the component. Also define:

- Whether `/audio:config` invoked while an agent is running waits for idle, opens immediately, or is rejected.
- Whether repeated invocation can open multiple components.
- Whether Ctrl+C behaves like Esc and emits an exit cue, since `tui.select.cancel` can have multiple configured keys.
- Whether page-up/page-down, search, Home/End, or wraparound navigation emits `settingsNavigate`, and once per key or once per selected-index change.
- Whether the individual editor includes `settingsThemePreview` (Section 6.3 says non-preview events only, which is reasonable but should list the exact rows).
- Exact labels, current-value text, help text, notice wording/lifetime, and minimum-width/overflow behavior if UI appearance is part of acceptance.
- Command-name collision behavior; Pi may suffix duplicate extension command names, which would violate the promised exact `/audio:config` name.

### 16. Save ordering and failure behavior are incomplete

The PRD carefully specifies play-before-save for disabling and save-before-play for enabling, but does not say what happens when save fails.

**Questions:**

- Does the UI revert the toggle/theme after a failed save?
- Is a save failure one of the allowed Settings-only notices?
- Can a cue play if persistence failed?
- Does “Exit root settings screen: Persist any prior changes” imply changes are buffered, despite individual actions also saying “Save first”?

### 17. Preview cannot reliably prove audibility

A successful process spawn does not prove that a device exists or that sound was audible. The PRD correctly limits the notice to launch failure in some places, but acceptance says “preview audible.”

**Clarification needed:** Separate automated acceptance (“approved player launched with the expected packaged path”) from manual acoustic acceptance (“a tester heard the cue”). Define whether a nonzero exit after successful spawn produces an in-UI notice.

## Playback and lifecycle questions

### 18. Non-blocking needs a measurable definition

The event handler must not await the child, but spawning and filesystem/config work can still block or reject.

**Questions:**

- May handlers await configuration writes initiated by UI actions?
- Is there a maximum permitted handler latency?
- Should asset existence be validated at startup/build only, or synchronously on every request?
- Must every spawn/error/listener path be caught internally to avoid Pi’s extension-error logging, given the “no output/diagnostic logs” principle?

### 19. Child-process lifecycle details are missing

Define:

- Spawn options (`stdio`, detached state, windows visibility, environment/cwd).
- Whether only the direct child or its process tree is terminated.
- Shutdown signal/method and whether shutdown waits for exit.
- Behavior if termination fails.
- Whether queued requests are simply discarded on shutdown.
- Whether child references are removed on `exit`, `close`, or `error` and how double events are handled.

### 20. Asset resolution requirements need an exact mechanism

“Relative to the installed package” rules out `cwd`, but does not choose a module-safe method. Define the expected package layout and resolution convention (for example, `import.meta.url` plus a fixed assets directory), especially if both ESM and CommonJS or source TypeScript and built JavaScript are supported.

### 21. Playback failures versus Settings notices are inconsistent

General requirements say failures are quiet, while preview may notify on “launch failure.” Define the exact error classes eligible for notice: missing executable, permission error, missing WAV, invalid argument, nonzero exit, timeout, or device failure. Also define whether missing/corrupt packaged assets indicate a release defect that should still remain silent at runtime.

## Acceptance and test gaps

### 22. Add deterministic cue-count tests

The matrix should define exact expected cue sequences for:

- Normal run with zero tools.
- Multiple tool calls, parallel failures, and failures exactly around the 1,000 ms boundary.
- Retry, rate-limit retry, auto-compaction retry, steering, and queued follow-up.
- Abort during model streaming, tool execution, retry delay, and after the run already settled.
- Esc pressed while idle or inside `/audio:config`.
- Completion arriving while each lower-priority cue is queued, starting, and playing.
- Configuration/theme changes while requests are queued.

### 23. Add configuration tests

Cover missing/partial/invalid/unsupported configs, unknown fields, failed reads/writes/renames, first creation, permissions, concurrent writers, reload, and preservation or removal of unknown keys according to the chosen policy.

### 24. Add package/reproducibility tests

Define:

- Exact expected asset count and path naming.
- WAV header/audio-format validation.
- Render reproducibility criterion.
- `npm pack --dry-run` allowlist or snapshot.
- Installation with production dependencies only.
- Tests from a path containing spaces and non-ASCII characters.
- Verification against the minimum and maximum supported Pi/Node versions.

### 25. Strengthen platform acceptance

“Where available” and “standard PowerShell environment” are not repeatable environments. Identify OS versions, CPU architectures, terminal/shell versions, audio stacks, and whether manual audible tests are release-gating. Clarify whether Intel macOS is required or best effort.

### 26. Add privacy and output-cleanliness verification

Specify how tests prove no runtime network calls and no stdout/stderr leakage from both successful and failed players. Include child-spawn errors, nonzero exits, malformed config, missing assets, and extension handler failures.

## Internal inconsistencies and editorial feedback

1. **Status/readiness:** “Ready for owner review” is not “ready for implementation.” Add a distinct implementation-approved status after all blocking decisions are resolved.
2. **Owner checklist vs completed mapping:** Checklist item 1 says to fill Section 7.2 mappings, but the table contains no `TBD` values. Change this to “approve mappings” or identify which values are provisional.
3. **Tool-error policy:** The normative text already says the first cue represents the group, while checklist item 2 still asks the owner to confirm it. Resolve this rather than leaving both.
4. **Completion versus abort priority:** A priority list placing completion above abort is misleading when abort replaces completion. Model them as mutually exclusive run outcomes, then prioritize the chosen terminal outcome over other cues.
5. **“Every failed tool is recorded”:** FR-4 permits only global audio configuration to be persisted and forbids logs. Clarify that “recorded” means transient scheduler state, not persisted data.
6. **No-output promise:** Pi itself logs extension handler errors. The implementation requirements should explicitly require catching all expected filesystem/spawn/process errors inside the extension.
7. **Unsupported-version behavior vs migration:** Section 6 says unsupported versions use defaults; the plan says implement migration. State which schema versions migrate and which reset.
8. **TUI-only command:** Clarify whether the command is registered in every mode and returns silently outside TUI, or is conditionally registered. The latter can be difficult because mode is supplied in event/command context, not the extension factory.
9. **Theme terminology:** Distinguish Pi display themes from audio themes consistently to avoid confusing `ctx.ui` theme APIs with sound themes.
10. **Comments requirement:** The project guidelines call for thorough comments, but the PRD should prioritize documented public behavior and maintainability rather than prescribe comment volume as acceptance behavior.

## Recommended minimum additions before implementation

To make the PRD implementation-ready, add these normative artifacts:

1. An abort-detection feasibility decision and exact algorithm.
2. A scheduler state machine and priority/debounce decision table.
3. A complete Settings UI transition table, including root actions and theme selection/preview cue counts.
4. A precise local/remote/CI mode-gating algorithm.
5. A pinned asset-input manifest and deterministic WAV-rendering specification.
6. Exact macOS, Linux, and Windows spawn contracts and fallback/error rules.
7. A complete configuration validation, migration, atomic-write, and concurrent-process policy.
8. Final npm identity, license, Pi/Node support ranges, module format, and peer-dependency policy.
9. Expanded acceptance cases with exact cue sequences and reproducible platform environments.

Once those are approved and folded into the source-of-truth document, the remaining choices can safely be treated as ordinary internal implementation details rather than product assumptions.
