# `Pi-Audio-Feedback` Extension — Implementation Specification 

**Purpose:** Define the complete, testable implementation contract for the published Pi-Audio-Feedback package

**Status:** **Approved for implementation**

---

## 1. Product and MVP Boundary

'Pi-Audio-Feedback' is a global Pi npm package that plays short, local, themed WAV cues for approved Pi lifecycle events and for the extension’s own Settings UI.

### In scope

- npm package name: `pi-audio-feedback`; install command: `pi install npm:pi-audio-feedback`.
- TUI-only local playback on macOS, native Windows 10/11, and Ubuntu/Debian Linux.
- Audio themes: **Core** (default), **Retro**, **Organic**, and **Soft**.
- App-start, agent-start, tool-error, experimental best-effort abort, agent-settled/completion, and Settings UI feedback.
- Persisted global configuration and `/audio:config`.

### Out of scope

- Shutdown, generic Pi UI error, `/skill`, `/extension`, and `subagent` cues.
- RPC, JSON, print, CI, SSH, remote-host, remote-client, and WSL audio.
- Runtime downloads, custom sound files/commands, volume/device controls, speech, telemetry, or diagnostics logs.

### Implementation-approved status gate

The owner approvals recorded in Section 13 satisfy the implementation gate. This specification is **Approved for implementation**, and all technical rules in this document are normative. Publication remains contingent on passing the Section 11 automated and manual release criteria.

---

## 2. Exact Playback Eligibility

Audio is eligible only when every condition below is true at **cue launch time**:

1. `ctx.mode === "tui"`.
2. No CI marker is truthy.
3. No SSH marker is present.
4. The event toggle is enabled under the request's toggle policy. The default policy checks current in-memory configuration at launch. Only the pre-save `settingsToggleOff` confirmations defined in Section 9 may use an enabled-at-acceptance snapshot.
5. The event has a valid mapping and packaged WAV for the request's theme: the active audio theme by default, or the validated candidate-theme override used only by Settings preview.

### 2.1 CI rule

Treat any of these variables as CI markers when their value is nonempty and not case-insensitively equal to `"false"` or `"0"`:

```text
CI, CONTINUOUS_INTEGRATION, BUILD_ID, BUILD_NUMBER,
GITHUB_ACTIONS, GITLAB_CI, BUILDKITE, JENKINS_URL, TF_BUILD
```

### 2.2 SSH rule

Treat Pi as SSH-hosted when any of these variables is nonempty:

```text
SSH_CONNECTION, SSH_CLIENT, SSH_TTY
```

A local Pi TUI whose tools operate remotely is still local and may play audio. A TUI process reached through SSH is silent, even though it is TUI mode. RPC is always silent because its mode is not `tui`.

No UI notice is emitted when a cue is suppressed by mode, CI, or SSH policy.

---

## 3. Package, Compatibility, and Distribution

| Area | Specification |
|---|---|
| npm identity | `pi-audio-feedback`, public, unscoped unless the owner changes it before first publication. |
| Module format | ESM package (`"type": "module"`) with TypeScript extension source loaded by Pi. |
| Pi manifest | `package.json` contains `"pi": { "extensions": ["./extensions"] }` and `"keywords": ["pi-package"]`. |
| Pi compatibility | `@earendil-works/pi-coding-agent >=0.80.6 <1.0.0`; this is the first verified API version for `agent_settled`, `getAgentDir()`, lifecycle hooks, and custom TUI APIs used here. |
| Node compatibility | `>=20`; CI tests Node 20, 22, and 24. |
| Pi dependencies | Pi-provided packages imported by the extension are listed as `peerDependencies` with `"*"`, not bundled. |
| License | MIT for package code, generated WAVs, and package documentation, with all required bundled third-party notices. |
| Versioning | Semantic Versioning. Pre-1.0 breaking configuration/event changes increment the minor version. |
| Runtime network | Forbidden. All patch data and WAVs are inside the published tarball. |
| Package inclusion | Use `package.json#files` and/or `.npmignore` to exclude non-runtime material while explicitly retaining `scripts/play-wav.ps1`, extension code, generated WAVs, notices, and package metadata. |

The README must document supported platforms, unsupported SSH/CI/WSL behavior, security implications of installing Pi packages, `/audio:config`, and the exact Pi/Node compatibility range.

---

## 4. Audio Asset Build Specification

### 4.1 Authoritative inputs

The release repository contains `assets/patches/manifest.json`. It is the authoritative asset-input manifest and must list one record for every theme:

```json
{
  "renderer": {
    "webKitsAudioVersion": "0.1.0",
    "nodeWebAudioApiVersion": "1.0.9",
    "sampleRateHz": 48000,
    "channels": 1,
    "pcmBitDepth": 16,
    "minimumDurationMs": 200,
    "tailMs": 750,
    "fadeOutMs": 5,
    "normalization": "none"
  },
  "provenance": {
    "repository": "https://github.com/derekluciani/pi-audio-feedback.git",
    "ref": "e2c768728106736413fb4ff725b20303afbe9a06",
    "upstreamCatalog": "https://audio.raphaelsalaja.com/library"
  },
  "themes": {
    "core": { "source": "assets/patches/core.json", "sha256": "b9702e7cc9e018cbd42736ece94d47540697ac17e675c2d531c2db40ffa3ddfb" },
    "retro": { "source": "assets/patches/retro.json", "sha256": "134013b63261d50c2a24049e758f0346e1f9f474de2c6c9c1cdb33db6d20b2fc" },
    "organic": { "source": "assets/patches/organic.json", "sha256": "d67d124f70feefd091ca0b5771e32768f3fef706824ef2f1cb09b7d9eb6f10a0" },
    "soft": { "source": "assets/patches/soft.json", "sha256": "c76ff281d8023009aa7d1b37ef1c46e3944b310634d6d0988242371a0b0c9b98" }
  }
}
```
The committed JSON files and their SHA-256 values are the authoritative rendering inputs. The manifest's immutable repository/ref identifies the commit that introduced the exact files, while `upstreamCatalog` records their upstream catalog origin. Builds never fetch provenance URLs; they read only the committed files and fail on a checksum mismatch. Generated modules in `./.web-kits` are not authoritative inputs.

### 4.2 Deterministic renderer recipe

1. Run the build only in the pinned CI environment declared by the repository toolchain.
2. Before importing `@web-kits/audio`, install `node-web-audio-api` globals needed for offline rendering.
3. Render each mapped patch definition into a mono, 48 kHz, signed-16-bit little-endian PCM WAV.
4. Render duration is the maximum declared layer delay plus envelope attack, decay, release, and a fixed 750 ms effect tail; it is never less than 200 ms.
5. Preserve source gains: no normalization, compression, or automatic clipping correction is applied after rendering.
6. Apply a 5 ms linear fade-out only at the end of the generated buffer to prevent a hard PCM cutoff.
7. Output path: `assets/wav/<theme>/<patch-sound-name>.wav`.
8. Generated WAVs and `assets/wav/manifest.json` are committed release artifacts. `npm pack` must include them.
9. CI regenerates the assets and compares SHA-256 values with the committed WAV manifest. A mismatch fails the build.

The reproducibility requirement is **byte-identical generated WAVs in the pinned CI environment**. User machines never render WAVs.

### 4.3 Mapping validation

The Section 10 mapping table is an approved release input. Build validation must:

- confirm every mapped patch sound exists in the exact pinned theme patch;
- generate the corresponding WAV;
- confirm the generated WAV exists at the expected package-relative path;
- reject duplicate output paths;
- emit a build-only error identifying theme, logical event, and missing patch sound.

---

## 5. Platform Player Contracts

All adapters receive a packaged absolute WAV path. They use `spawn()`/`spawnSync()` detection only where stated, never a shell string. Runtime playback is non-blocking: Pi never awaits a player child.

### 5.1 Common spawn contract

```text
cwd: dirname(wavPath)
env: process.env
stdio: "ignore"
detached: false
windowsHide: true
shell: false
```

The scheduler records the direct child, removes it on the first `error` or `close` event, and treats either event as playback completion. A watchdog of `wavDurationMs + 2,000 ms` kills a still-running direct child, clears the scheduler, and starts an eligible pending cue. The watchdog is session-scoped and cleared on every normal child completion.

On `session_shutdown`, discard all pending cues, clear watchdogs, and call `child.kill()` on each tracked direct child. Do not wait for children and do not attempt to kill a process tree. Termination failure is ignored.

### 5.2 macOS

```text
executable: afplay
args: [wavPath]
```

`afplay` is resolved through normal `PATH` lookup. A spawn error is a launch failure. A nonzero close after a successful spawn is silent; it does not trigger a fallback.

### 5.3 Ubuntu/Debian Linux

Primary adapter:

```text
executable: paplay
args: [wavPath]
```

Fallback adapter:

```text
executable: aplay
args: [wavPath]
```

Use `aplay` **only** when `paplay` fails to spawn with `ENOENT`. Do not fall back after `paplay` starts, even if it later exits nonzero; attempting both can create duplicate playback on systems with a delayed server response. Normal `PATH` resolution is approved and is not considered arbitrary probing.

### 5.4 Native Windows 10/11

Use Windows PowerShell only:

```text
executable: powershell.exe
args: [
  "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
  "-File", packagedPowerShellScriptPath,
  "-Path", wavPath
]
```

The package includes a fixed `scripts/play-wav.ps1`:

```powershell
param([Parameter(Mandatory = $true)][string]$Path)
$player = [System.Media.SoundPlayer]::new($Path)
$player.Load()
$player.PlaySync()
```

`-File` and a separate `-Path` argument preserve spaces, apostrophes, and non-ASCII characters without interpolating a path into PowerShell command text. `PlaySync()` intentionally keeps only the spawned player process alive until the cue completes; Pi itself remains non-blocking because it does not await that child. There is no `pwsh` fallback in MVP.

### 5.5 Playback failure notices

All automatic lifecycle cue failures are silent. A Settings theme-preview attempt may show a short in-UI notice for a launch failure: a pre-spawn validation failure (missing packaged player script or WAV), a synchronous `spawn()` throw, or the child's `error` event before successful launch (including `ENOENT` or `EACCES`). Node commonly reports missing executables asynchronously through `error`; this is still a launch failure. A nonzero child close or device/server failure after the child emits `spawn` remains silent because it does not reliably identify whether the user heard audio.

---

## 6. Scheduler State Machine

### 6.1 Terms

- **Request:** `{ event, requestedAt, priority, themeOverride?, togglePolicy }`, where `togglePolicy` is `"launch"` by default or `"accepted"` only for an approved pre-save toggle-off confirmation. `themeOverride`, when present, is a validated built-in audio-theme identifier; no WAV path is resolved until launch.
- **Playing:** a child has been spawned and has not emitted `error` or `close`.
- **Pending:** the single queue slot containing at most one request.
- **Launchable:** eligible under Section 2, config lookup, theme mapping, and asset existence.
- **Coalesced:** an event was observed but intentionally does not create another audio request.

Audio theme, event toggle, asset mapping, and package path are normally evaluated at **launch time**, not when a request enters the scheduler. A configuration change therefore affects a queued ordinary cue that has not started. Two explicit exceptions exist:

1. A Settings preview request retains its validated `themeOverride`, so it previews the highlighted candidate even if that theme is not saved or the active theme changes while the request waits.
2. A pre-save `settingsToggleOff` request may use `togglePolicy: "accepted"`. The caller must verify that `settingsToggleOff` is enabled when accepting the request; that snapshot remains valid if the subsequent save disables the toggle before launch. Mode/CI/SSH gating, mapping, and asset existence are still checked at launch.

### 6.2 Priorities and terminal outcomes

A low-level agent run has one terminal outcome:

```text
confirmed abort  -> agentAborted cue; no completion cue
otherwise        -> agentSettled completion cue
```

Priorities, highest first:

1. `agentSettled` completion for a non-aborted run
2. `agentAborted`
3. `toolError`
4. `settingsThemePreview`
5. `appStart`
6. `agentStart`
7. Remaining Settings UI events

### 6.3 Request algorithm

```text
request(event, options = {}):
  if event is toolError and its toggle is disabled at request time:
    discard without opening or extending a debounce window; return
  if event is toolError and now - toolErrorWindowStart < 1000 ms:
    mark event coalesced; return
  if event is toolError:
    toolErrorWindowStart = now

  validate any themeOverride against the four built-in theme ids
  if togglePolicy is "accepted":
    require event === settingsToggleOff and verify it is enabled now

  if no Playing:
    launch(event) if launchable; otherwise discard
    return

  if event.priority > Pending.priority (or Pending is empty):
    replace Pending with event
  else if event.priority === Pending.priority:
    retain the older Pending request
  else:
    discard event
```

Clarifications:

- A tool-error window begins when the first enabled `toolError` is accepted by the scheduler. A disabled tool error neither opens nor extends a window. A request exactly 1,000 ms after the anchor starts a new window; `< 1,000 ms` coalesces.
- A coalesced error does not create a later queued sound. “Every tool failure is recorded” means transient in-memory scheduler accounting only; it is not persisted or logged.
- If no `Pending` exists, any request can become pending while another cue is playing. If a `Pending` exists, only a strictly higher-priority incoming request replaces it.
- A newly arrived completion replaces any pending lower-priority request, but never kills the currently playing child. It launches after the current child closes, errors, or hits its watchdog.
- On child completion, launch and remove `Pending` if it is still launchable; otherwise discard it.
- A queued request expires after 2,000 ms, except a completion request, which expires only at session shutdown. Expired requests are discarded.
- Launch failure clears `Playing` immediately and proceeds to the eligible pending request.

### 6.4 Expected scheduler behavior

| Current state | Incoming request | Result |
|---|---|---|
| Idle | Any launchable event | Start immediately. |
| Playing lower priority | Completion | Retain current cue; replace pending; start completion after child ends. |
| Playing cue, no pending | Tool error | Queue one tool-error cue. |
| Playing cue, pending tool error | Another tool error within 1 s | Coalesce; do not modify pending. |
| Playing cue, pending navigation | Tool error | Replace pending navigation with tool error. |
| Playing cue, pending completion | Any lower event | Discard lower event. |
| Any | Shutdown | Clear queue, stop direct children, make no further launches. |

---

## 7. Agent and Abort Event Algorithms

### 7.1 Agent-start behavior

`agent_start` plays an `agentStart` cue for **every** low-level agent run, including retry, auto-compaction retry, steering continuation, and queued follow-up. Scheduler priority/expiry may suppress the cue when a higher-priority cue is pending or playing.

Expected count: a straightforward prompt with no retry has one start cue; each additional Pi-emitted `agent_start` is another eligible start cue.

### 7.2 Experimental abort detection

Abort audio is explicitly **best effort / experimental**. It supports only a literal physical Escape key in a local TUI; it does not promise support for a user-remapped `app.interrupt` binding or programmatic aborts from other extensions.

The extension uses `ctx.ui.onTerminalInput()` as an additive raw-input listener. It does not replace the editor, register a shortcut, or interfere with Pi’s key handling. It registers the listener in `session_start` and unregisters it in `session_shutdown`.

State machine:

1. On `agent_start`, increment `runGeneration` and set `activeGeneration`.
2. On raw input matching literal `Escape`, set `escapeGeneration = activeGeneration` only while a run is active.
3. On `agent_end`, inspect `event.messages` for the final assistant message. If `escapeGeneration === activeGeneration` and that message has `stopReason === "aborted"`, set `terminalOutcome = "aborted"` for that generation.
4. On `agent_settled`, if the active generation has `terminalOutcome === "aborted"`, request `agentAborted`; otherwise request `agentSettled`.
5. Clear Escape/outcome state after settlement, on the next `agent_start`, and during `session_shutdown`.

If the assistant message field is absent, unexpected, or not exactly `"aborted"`, the extension does **not** emit abort audio and treats the run as non-aborted. This intentionally prefers a missed cue over a false abort cue.

This algorithm does not distinguish provider cancellation, tool cancellation, compaction, retry cancellation, or a different extension’s `ctx.abort()` unless they also meet the literal-Escape plus assistant-`stopReason` condition.

### 7.3 Other Pi hooks

| Logical event | Hook | Additional rule |
|---|---|---|
| `appStart` | `session_start` where `reason === "startup"` | Config is loaded before the cue is requested. |
| `agentStart` | `agent_start` | Section 7.1 controls cue count. |
| `toolError` | `tool_execution_end` where `isError === true` | Observation only; never mutate/block a tool. |
| terminal outcome | `agent_settled` | Use the outcome algorithm above. |

---

## 8. Configuration Persistence Contract

### 8.1 File location and first run

Configuration is global and project-independent:

```text
<getAgentDir()>/pi-audio-feedback.json
```

On a first run, the extension uses in-memory defaults and does **not** create a file. It creates the file only after the first successful Settings mutation. If the agent directory is absent, the extension may create it recursively with `0700` permissions on POSIX platforms. Configuration files are created with `0600` permissions on POSIX platforms; Windows uses its normal user-profile ACLs.

### 8.2 Schema behavior

```json
{
  "version": 1,
  "theme": "core",
  "events": {
    "appStart": true,
    "agentStart": true,
    "toolError": true,
    "agentAborted": true,
    "agentSettled": true,
    "settingsRootEnter": true,
    "settingsRootExit": true,
    "settingsSubmenuEnter": true,
    "settingsSubmenuExit": true,
    "settingsNavigate": true,
    "settingsOptionSelect": true,
    "settingsToggleOn": true,
    "settingsToggleOff": true,
    "settingsThemePreview": true
  }
}
```

Validation policy:

| Input condition | Behavior |
|---|---|
| File missing | Use defaults; do not write until Settings mutation. |
| Missing known field | Supply its default. |
| Unknown field/event | Preserve it during a valid write but ignore it at runtime. |
| Wrong type for a known field | Use that field’s default; retain other valid known fields. |
| Unknown theme | Use `core`; retain other valid values. |
| Empty/malformed JSON | Use defaults; do not overwrite merely by loading; show one Settings-only notice when `/audio:config` opens. An explicit user mutation may replace it as described below. |
| Symlink or unreadable file | Use defaults; preserve the path; show one Settings-only notice. Reject Settings mutations until the user removes or repairs it. |
| Version `1` | Use directly after field-level validation. |
| Version `<1` | No historical schema exists; treat as malformed/default. An explicit user mutation may replace it. |
| Version `>1` | Treat as unsupported/default; preserve it and reject Settings mutations to prevent destructive downgrade. |

No automatic migration exists in MVP. A later schema version must define an explicit migration before adding it to code.

### 8.3 Writes and concurrent Pi processes

For every Settings mutation:

1. Re-read and classify the on-disk path. For a valid version-1 file, merge only the mutation and preserve unknown fields. For a missing file, start from defaults. For malformed JSON or a version below 1, an explicit Settings mutation is authorization to replace the invalid content with validated defaults plus that mutation. For a symlink, unreadable file, or version above 1, reject the mutation and preserve the path.
2. Validate the complete merged/replacement configuration before writing.
3. Write JSON with a trailing newline to a unique temporary file in the same directory, mode `0600` on POSIX.
4. Flush the temporary file, close it, then rename it over the target file.
5. Best-effort flush the containing directory on POSIX.
6. Update in-memory state only after rename succeeds.

The concurrency policy is **last-writer-wins per completed mutation**. Re-reading immediately before every write reduces, but does not eliminate, races between simultaneous processes. No lock file is used in MVP.

On write failure, the UI reverts to the previous in-memory value, shows a Settings-only non-persistent failure notice, and plays no post-save cue. A pre-save toggle-off cue may already have played; this is acceptable.

Configuration is loaded at `session_start`, reloaded when `/audio:config` opens, and re-read immediately before a mutation. `/reload`, `/new`, `/resume`, and `/fork` create a session context that loads current configuration again. A waiting scheduler request uses the configuration present at launch time.

---

## 9. Settings UI Contract

### 9.1 Availability and lifecycle

The extension registers `/audio:config` in every mode because command registration occurs in the extension factory. The handler behaves as follows:

- In TUI mode while Pi is idle: open or focus the one existing audio Settings component.
- In TUI mode while Pi is active: show a non-audio notice that settings are available when Pi is idle; do not open a component.
- In non-TUI modes: return without opening UI or playing sound.
- Reinvoking while the component is open focuses the existing component; no duplicate overlay/component is created.

Visual layout is not a release acceptance criterion. Semantic labels, transitions, persistence, and keyboard behavior are.

### 9.2 Root menu and exact action cues

Root options:

1. **Turn all sounds on**
2. **Turn all sounds off**
3. **Edit individual sound playback**
4. **Select Audio Theme**

| Action | State/persistence behavior | Exactly one cue behavior |
|---|---|---|
| Open `/audio:config` | No config write | `settingsRootEnter`, if enabled. |
| Turn all sounds on | Set every known event toggle true; atomic save. | On successful save, `settingsToggleOn`. If already all on, no write/cue. |
| Turn all sounds off | If `settingsToggleOff` is currently enabled, request it with `togglePolicy: "accepted"`; then set every known event toggle false and atomic save. | The pre-save `settingsToggleOff` cue is the only cue and remains eligible if queued until after the save. If already all off, no write/cue. |
| Open individual editor | No config write | `settingsSubmenuEnter` only. |
| Open theme selector | No config write | `settingsSubmenuEnter` only. |
| Exit root | No additional save; mutations already save immediately | `settingsRootExit`, if enabled. |

Root actions do not also emit `settingsOptionSelect`.

### 9.3 Navigation and cancellation

- Up/Down, Page Up/Page Down, Home, and End emit `settingsNavigate` once only when the selected index actually changes.
- Selection is clamped at list boundaries; no wraparound exists.
- Escape and Ctrl+C close the active Settings level. They emit the relevant root/submenu exit cue only when that cue is enabled.
- Search is not part of MVP. The UI must not emit navigation sounds for text input because it has no text-input setting fields.
- The component uses Pi’s injected keybinding-aware controls for list selection/cancellation where available.

### 9.4 Individual event editor

The editor includes toggles for all non-preview lifecycle and Settings events:

```text
appStart, agentStart, toolError, agentAborted, agentSettled,
settingsRootEnter, settingsRootExit, settingsSubmenuEnter,
settingsSubmenuExit, settingsNavigate, settingsOptionSelect,
settingsToggleOn, settingsToggleOff
```

It does not include `settingsThemePreview`; that cue is controlled only by the theme selector and remains enabled by default.

Enabling one event: save first, then play `settingsToggleOn` if that cue remains enabled. Disabling one event: if `settingsToggleOff` is currently enabled, request it with `togglePolicy: "accepted"` before save; if the save fails, revert state and show a Settings-only notice. The accepted snapshot permits a queued toggle-off cue to launch after the save.

### 9.5 Theme selector and preview

- Moving a highlighted theme is silent except for ordinary `settingsNavigate`.
- Pressing **Enter** confirms the highlighted theme, atomically saves it, and emits **one** `settingsOptionSelect` cue using the newly selected audio theme.
- Pressing **Space** previews the highlighted theme without saving and emits `settingsThemePreview` with the highlighted built-in theme as `themeOverride`.
- The selector must display persistent helper text while open: **“Space preview • Enter save • Esc cancel”**. Equivalent keybinding-aware formatting is allowed, but the preview action must be explicitly discoverable.
- Theme confirmation does not also emit `settingsThemePreview`; one Enter must never produce two sounds.
- If `settingsThemePreview` is disabled, Space preview is silent; theme confirmation still saves and uses `settingsOptionSelect` if enabled.
- Escape leaves the selector without changing the already confirmed theme.

The documented macOS self-test is: open **Select Audio Theme**, highlight a theme, press **Space**, and confirm that the preview starts through `afplay`; press Enter to persist it.

---

## 10. Event-to-Theme Patch Mapping

The following mappings are approved release mappings. Build validation must prove every patch name exists in its pinned source before code or package release.

| Logical event | Core | Retro | Organic | Soft |
|---|---|---|---|---|
| `appStart` | `success` | `success` | `success` | `success` |
| `agentStart` | `copy` | `copy` | `copy` | `copy` |
| `toolError` | `delete` | `error` | `error` | `error` |
| `agentAborted` | `warning` | `warning` | `warning` | `warning` |
| `agentSettled` | `notification` | `notification` | `notification` | `notification` |
| `settingsRootEnter` | `modal-open` | `page-enter` | `page-enter` | `page-enter` |
| `settingsRootExit` | `modal-close` | `page-exit` | `page-exit` | `delete` |
| `settingsSubmenuEnter` | `dropdown-open` | `expand` | `expand` | `tab-switch` |
| `settingsSubmenuExit` | `dropdown-close` | `collapse` | `collapse` | `undo` |
| `settingsNavigate` | `deselect` | `deselect` | `deselect` | `hover` |
| `settingsOptionSelect` | `select` | `select` | `select` | `select` |
| `settingsToggleOn` | `toggle-on` | `toggle-on` | `toggle-on` | `toggle-on` |
| `settingsToggleOff` | `toggle-off` | `toggle-off` | `toggle-off` | `toggle-off` |
| `settingsThemePreview` | `notification` | `notification` | `notification` | `notification` |

---

## 11. Acceptance Criteria

### 11.1 Deterministic scheduler tests

Tests must assert exact request/start sequences for:

1. Normal prompt with zero tools: `agentStart`, then `agentSettled`.
2. Parallel failures at `0 ms`, `999 ms`, and `1,000 ms`: first and third tool-error groups are eligible; second is coalesced.
3. Completion arriving while a navigation cue is playing: navigation completes; completion launches next; no navigation remains pending.
4. Completion arriving while a tool error is pending: completion replaces pending error.
5. Retry, auto-compaction retry, steering, and queued follow-up: each Pi `agent_start` is eligible for an `agentStart` request; only final non-aborted settlement gets completion.
6. Esc while idle or Settings UI is open: no abort request.
7. Literal Esc followed by a non-aborted final assistant message: no abort request.
8. Literal Esc followed by an aborted final assistant message: one abort request and no completion request.
9. Configuration/theme mutation while an ordinary cue waits: launch uses the current configuration at launch time.
10. Previewing an unsaved candidate theme: the request retains that candidate and resolves its WAV at launch even when the active theme differs.
11. A queued pre-save `settingsToggleOff` accepted while enabled remains launchable after the save disables all toggles.
12. A disabled `toolError` does not open or extend the debounce window.

### 11.2 Configuration tests

Test missing, partial, malformed, unreadable, symlink, wrong-type, unknown-field, unknown-theme, older-version, and newer-version configurations. Test first write, failed write/rename, atomic replacement, unknown-field preservation, last-writer-wins behavior, session reload behavior, and no automatic overwrite of an invalid/unsupported configuration.

### 11.3 Asset and package tests

1. Verify the patch manifest contains the immutable repository/ref provenance and SHA-256 value for every theme, and verify each committed patch against that checksum.
2. Verify every generated WAV has RIFF/WAVE headers, mono 48 kHz PCM 16-bit format, expected path, and manifest SHA-256.
3. Regenerate assets in pinned CI and require byte-identical output.
4. Snapshot `npm pack --dry-run`; require code, WAVs, notices, PowerShell script, and package manifest, while excluding source-only artifacts not needed at runtime.
5. Install with production dependencies only.
6. Test package/asset resolution from a path containing spaces and non-ASCII characters.
7. Test on Node 20, 22, and 24 and on the minimum supported Pi version.

### 11.4 Platform acceptance

| Environment | Automated release requirement | Manual release-gating requirement |
|---|---|---|
| macOS 14+ Apple Silicon | Correct `afplay` arguments and no output leakage | Tester hears preview and lifecycle cue. |
| macOS 14+ Intel | Correct `afplay` arguments and no output leakage | Best-effort manual test; not a release blocker if unavailable. |
| Ubuntu 22.04+ x64, PipeWire/PulseAudio | Correct `paplay` arguments | Tester hears preview. |
| Ubuntu 22.04+ x64, ALSA-only fixture | `paplay` `ENOENT` falls back to `aplay` | Tester hears preview where fixture is available. |
| Windows 11 x64, Windows PowerShell 5.1 | Correct `powershell.exe -File` arguments | Tester hears preview and lifecycle cue. |
| WSL | None | Explicitly unsupported. |

Automated tests verify process launch/arguments, scheduler state, error handling, and output cleanliness; they do not claim audibility. Manual release tests record whether a tester heard the cue.

### 11.5 Privacy and output tests

Tests must verify no runtime network call path exists, and player output never reaches Pi stdout/stderr for success, spawn error, nonzero close, missing asset, malformed config, or failed Settings write. Expected filesystem/process errors are caught inside the extension so Pi does not log extension-handler errors.

---

## 12. Implementation Plan

1. **Release foundation** — create ESM npm package metadata, Pi manifest, compatibility checks, notices, README, and CI matrix.
2. **Asset pipeline** — verify the committed immutable patch manifest and selected patch JSON, then implement deterministic WAV generation, mapping validation, and artifact checksum tests.
3. **Core runtime** — implement config validation/atomic persistence, eligibility gate, scheduler state machine, package-relative asset resolver, and direct-child lifecycle handling.
4. **Platform adapters** — implement and test macOS, Linux fallback, and Windows PowerShell contracts exactly as Section 5 specifies.
5. **Pi integration** — implement lifecycle hooks, experimental abort listener/heuristic, and `/audio:config` state transitions.
6. **Verification** — complete Section 11 automated tests, then required manual platform acoustic tests before prerelease publication.

---

## 13. Owner Approvals — Complete

The following implementation inputs are approved and incorporated into the normative sections above:

| Concern | Owner response |
|---|---|
| 1. **Asset provenance:** Fill the four immutable patch source and SHA-256 entries in `assets/patches/manifest.json`. | Approved and materialized in the repository manifest. |
| 2. **License:** Approve MIT for package code/generated WAVs or supply another license. | Approved; MIT is normative in Section 3. |
| 3. **Abort scope:** Approve the experimental, literal-Escape-only heuristic and its intentional false-negative behavior. | Approved. |
| 4. **Mode policy:** Approve the exact CI and SSH suppression variable lists. | Approved. |
| 5. **Scheduler:** Approve the single-pending-slot queue, 2-second expiry, watchdog, and coalesced one-second tool-error groups. | Approved. |
| 6. **Settings behavior:** Approve Space-to-preview and Enter-to-save as separate one-cue actions. | Approved with the required in-selector helper text specified in Section 9.5. |
| 7. **Compatibility:** Approve the Pi/Node ranges and platform release matrix. | Approved. |
| 8. **Config policy:** Approve first-write timing, validation/migration behavior, atomic write procedure, and last-writer-wins concurrency policy. | Approved. |

---

## 14. References

- Pi extension lifecycle, events, package rules, TUI, and keybindings: installed Pi `docs/extensions.md`, `docs/packages.md`, `docs/tui.md`, and `docs/keybindings.md`.
- Pi extension types: `@earendil-works/pi-coding-agent` type definitions.
- `@web-kits/audio` patch format and catalog: https://audio.raphaelsalaja.com/integrations/patches and https://audio.raphaelsalaja.com/library.
- `@web-kits/audio` upstream offline-rendering example: https://github.com/raphaelsalaja/audio.
