# Pi SFX Extension — Implementation Requirements and Plan

**Status:** Ready for owner review

**Audience:** Extension owner and implementation team

**Purpose:** The sole source of truth for the published Pi SFX package, including its approved requirements, specifications, implementation plan, and acceptance criteria.

---

## 1. Product Definition

Pi SFX is a published npm Pi package that plays short, local, themed sound effects for meaningful Pi lifecycle events and for its own Settings UI.

### Primary user story

> When Pi has finished all automatic work and is ready for me, I hear a short completion sound. I can also hear selected start, error, abort, startup, and settings-navigation feedback, then change every sound or theme from Pi.

### Product principles

- **Supplemental:** Audio augments Pi; it never changes agent, tool, or session behavior.
- **Local and private:** No network requests, telemetry, recordings, or task-content transmission at runtime.
- **Best effort:** A playback failure must never delay, fail, or add output to Pi.
- **Configurable:** All in-scope cues are enabled after first install; users can enable/disable each independently.
- **Themed:** The same logical event uses a sound selected from the active theme.

---

## 2. Scope

### MVP in scope

- A published npm Pi package, installable through `pi install npm:<package>`, for global personal use.
- Local playback only in Pi TUI mode (`ctx.mode === "tui"`).
- Build-time conversion of curated `@web-kits/audio` patches to bundled WAV assets.
- Supported themes: **Core** (default), **Retro**, **Organic**, and **Soft**.
- Global persisted configuration and the custom `/audio:config` Settings UI.
- App-start, agent-start, tool-error, agent-abort, agent-settled/completion, and Settings UI cues.
- macOS, native Windows 10/11, and Ubuntu/Debian Linux support as defined in Section 5.

### MVP out of scope

- Shutdown sound. A `/quit`-only cue is not reliably detectable through Pi’s public extension API.
- Generic `Error: {string}` UI-message sounds.
- `/skill`, `/extension`, and `subagent` invocation sounds, including integration with separately installed extensions.
- RPC, JSON, print, CI, remote-host, and remote-client playback.
- WSL support beyond best-effort manual experimentation.
- User-provided sound paths, arbitrary player commands, custom volume controls, audio-device selection, speech, streaming audio, or music.
- Telemetry, analytics, diagnostic logs, and runtime network downloads.

---

## 3. Package and Audio Architecture

### 3.1 Package requirements

| Requirement | Specification |
|---|---|
| Distribution | Public npm package with the `pi-package` keyword and a `pi.extensions` manifest. |
| Pi resource | One TypeScript extension entry point in the package `extensions/` directory, declared in `package.json` under the top-level `pi` object: `{ "pi": { "extensions": ["./extensions"] } }`. |
| Runtime behavior | The installed package must work without downloading patches or assets. |
| Runtime dependencies | Keep runtime dependencies minimal; do not require a native Node audio engine. |
| Build dependencies | Pin `@web-kits/audio` and the Node Web Audio renderer/polyfill used to generate WAV assets. |
| Assets | Include generated WAV assets in the published npm tarball. The runtime must resolve assets relative to the installed package, never from the working project. |
| Attribution | Preserve required MIT-license attribution/notices for `@web-kits/audio` and the curated patches. |
| Package metadata | Before publish, define npm package name/scope, repository URL, versioning policy, license, README, supported Pi version, and supported Node version. |

### 3.2 Approved patch-to-WAV pipeline

`@web-kits/audio` is a Web Audio library: its patches are JSON sound definitions rather than guaranteed ready-to-play WAV files. Pi runs in Node.js, where browser `AudioContext` playback is not available.

The package **MUST** use this pipeline:

```text
Pinned curated patch JSON
  -> build-time Node Web Audio polyfill + @web-kits/audio offline rendering
  -> generated WAV assets, committed or generated before publish
  -> WAV assets included in npm package
  -> OS-specific player adapter at Pi runtime
```

Requirements:

1. Patch acquisition and WAV generation happen during development/build/release, not during a user’s Pi session.
2. The build **MUST** validate every supported theme against the event-to-theme mapping in Section 7.
3. A release **MUST** fail if an enabled event has no mapped sound in any supported theme.
4. WAV generation settings (sample rate, channel count, duration/tail policy) **MUST** be deterministic and recorded in build documentation.
5. Runtime playback **MUST** use only the packaged WAV assets; it must not synthesize Web Audio live.

### 3.3 Easiest macOS user test

The Settings UI provides the primary self-test:

1. Install or temporarily run the package (`pi install npm:<package>` or `pi -e ./path/to/package`).
2. Start Pi locally on macOS.
3. Run `/audio:config` → **Select Audio Theme**.
4. Confirming a theme plays that theme’s preview cue through `afplay`.
5. Run a normal prompt to confirm agent-start and final-settlement cues.

The theme preview is a user-facing playback test. It must display a non-fatal Settings UI notice if the macOS player cannot be started; it must not write diagnostics or errors to normal Pi output.

---

## 4. Runtime Playback Contract

### 4.1 General behavior

1. Audio requests **MUST** be non-blocking. Pi event handlers must not await the player process.
2. Player processes **MUST** use argument arrays, never shell-interpolated commands.
3. Player `stdin`, `stdout`, and `stderr` **MUST** be ignored or captured so no player text corrupts Pi’s TUI, JSON, or print output.
4. Missing players, missing devices, invalid assets, and process errors **MUST** fail quietly from Pi’s perspective.
5. The extension factory **MUST NOT** create persistent processes, watchers, or timers. Session resources start on demand and are cleaned up in `session_shutdown`.
6. `session_shutdown` cleanup must terminate only tracked, still-running player children; short one-shot sounds normally exit naturally.

### 4.2 Priority, debounce, and overlap rules

| Rule | Requirement |
|---|---|
| Completion priority | For a non-aborted run, `agent_settled` completion has the highest priority. When requested, it drops lower-priority cues that are pending or would collide with it. It does not retroactively stop a cue already heard. A confirmed abort replaces completion for that run. |
| Tool errors | Every failed tool is recorded. The scheduler emits at most one `tool-error` cue per **1,000 ms** group; later failures in that window are coalesced into the same cue. |
| Other events | Event requests are queued only if no higher-priority cue is pending/starting. Lower-priority UI navigation cues may be dropped under load. |
| Concurrent playback | The scheduler must avoid starting overlapping cues. It may wait for the current short cue to complete or discard the lower-priority request. |
| Completion semantics | Completion means Pi has settled and will not automatically continue. It does not assert that the user’s task was objectively successful. |

Recommended priority order: completion > abort > tool error > theme preview/selection > app start > agent start > Settings UI navigation.

---

## 5. Supported Platform Contract

The extension plays audio on the computer that runs the Pi extension. It does not send an audio instruction to an SSH client, RPC client, or another device.

| Target | MVP adapter | Support policy |
|---|---|---|
| macOS | `afplay <packaged-wav>` | Supported; test on Apple Silicon and Intel where available. |
| Ubuntu/Debian Linux | `paplay <packaged-wav>`; fall back to `aplay <packaged-wav>` | Supported when PulseAudio/PipeWire or ALSA playback is available. |
| Native Windows 10/11 | PowerShell/.NET WAV playback in a spawned process | Supported; test in Windows Terminal and a standard PowerShell environment. |
| WSL | No adapter guarantee | Best effort only; excluded from MVP acceptance. |
| SSH/remote Pi, RPC, JSON, print, CI | No playback | Explicitly disabled by mode/local-host policy. |

Requirements:

1. A platform adapter must be selected from `process.platform` without probing via shell text.
2. Linux may try the documented fallback chain only; it must not scan arbitrary commands or install system packages.
3. If no supported player is available, the extension is silent. The theme-preview action may show an in-UI, non-persistent failure notice.
4. Runtime audio must remain local to TUI mode. `ctx.mode !== "tui"` must suppress playback.

---

## 6. Configuration and Settings UI

### 6.1 Global configuration

Configuration is global, not project-specific, and persists across Pi sessions. Project-local settings are not read.

**Configuration root:** Pi's configured global agent directory, resolved through Pi configuration (`getAgentDir()`), not a hardcoded `.pi` path.

**Default file:** `<agentDir>/pi-extension-sfx.json` (normally `~/.pi/agent/pi-extension-sfx.json`)

**Schema version:** `1`

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
    "settingsToggleOn": true,
    "settingsToggleOff": true,
    "settingsOptionSelect": true,
    "settingsThemePreview": true
  }
}
```

Requirements:

- First install creates or uses the above defaults: **Core** theme and all in-scope events enabled.
- Invalid, unreadable, or unsupported-version configuration must not crash Pi. The extension uses safe defaults and may show a Settings UI notice only when the user opens `/audio:config`.
- **Turn all sounds on** sets every event toggle to `true`.
- **Turn all sounds off** sets every event toggle to `false`.
- These actions intentionally do not use a separate “master audio” setting; the user-facing behavior is exactly the selected root-menu language.

### 6.2 `/audio:config` custom TUI

`/audio:config` is an extension command available in TUI mode. It opens an extension-owned custom component; it does not alter or observe Pi’s built-in `/settings` component.

Root menu:

1. **Turn all sounds on**
2. **Turn all sounds off**
3. **Edit individual sound playback**
4. **Select Audio Theme**

| UI interaction | Key | Logical event | Required behavior |
|---|---|---|---|
| Open root settings screen | command / Enter | `settingsRootEnter` | Play when enabled. |
| Exit root settings screen | Esc | `settingsRootExit` | Persist any prior changes, then play when enabled. |
| Navigate a list | Up / Down | `settingsNavigate` | Play when enabled; low priority. |
| Open individual-event or theme submenu | Enter | `settingsSubmenuEnter` | Play when enabled. |
| Exit a submenu | Esc | `settingsSubmenuExit` | Play when enabled. |
| Enable an event | Enter | `settingsToggleOn` | Save first, then play the enabled-state cue. |
| Disable an event | Enter | `settingsToggleOff` | Play before saving the disabled state, so the action remains audible. |
| Select a radio/choice option | Enter | `settingsOptionSelect` | Persist selection, then play using the newly selected theme where applicable. |
| Preview selected theme | Enter in theme selector | `settingsThemePreview` | Attempt a test sound through the selected theme/player; show a non-fatal UI notice only on launch failure. |

Mute/re-enable behavior: when all event toggles are off, Settings UI navigation is silent. Selecting **Turn all sounds on** sets the toggles to on, then plays the confirmation cue.

### 6.3 Individual sound playback editor

The editor must show one toggle for every currently in-scope non-preview event. It must explain that a disabled event will not play, including during Settings navigation. The theme-preview action remains available while choosing a theme and is governed by `settingsThemePreview`.

---

## 7. Event Specification and Theme Mapping

### 7.1 Pi event contract

| Logical event | Pi trigger / implementation strategy | Reliability | Default | Notes |
|---|---|---|---:|---|
| `appStart` | `session_start` with `reason === "startup"` | Reliable | On | Fires after the extension is loaded, not before Pi process initialization. |
| `agentStart` | `agent_start` | Reliable | On | May fire again for retries/continuations. |
| `toolError` | `tool_execution_end` where `isError === true` | Reliable | On | Uses the 1,000 ms error debounce group. |
| `agentAborted` | Record Esc during active TUI run; confirm an aborted final assistant result before cue | Best effort | On | Pi has no dedicated public `agent_aborted` event. Never cue merely because Esc was pressed. A confirmed abort suppresses completion for that run. |
| `agentSettled` | `agent_settled` | Reliable | On | Primary completion cue for a non-aborted run; do not substitute `agent_end`. |
| `settings*` | State transitions inside `/audio:config` | Reliable in extension UI | On | Not available for Pi’s built-in Settings UI. |

### 7.2 Owner event-to-theme-patch mapping

The owner specifies the patch sound name for each logical event and supported theme below. The implementation team must not infer a missing mapping. `TBD` means the mapping must be supplied before the corresponding theme/event is released.

| Logical event | Suggested semantic sound | Core patch sound | Retro patch sound | Organic patch sound | Soft patch sound |
|---|---|---|---|---|---|
| `appStart` | notification / info | **TBD** | **TBD** | **TBD** | **TBD** |
| `agentStart` | send / info | **TBD** | **TBD** | **TBD** | **TBD** |
| `toolError` | error | **TBD** | **TBD** | **TBD** | **TBD** |
| `agentAborted` | warning / undo | **TBD** | **TBD** | **TBD** | **TBD** |
| `agentSettled` | notification / success | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsRootEnter` | page-enter | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsRootExit` | page-exit | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsSubmenuEnter` | expand | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsSubmenuExit` | collapse | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsNavigate` | hover / tap | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsToggleOn` | toggle-on | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsToggleOff` | toggle-off | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsOptionSelect` | select | **TBD** | **TBD** | **TBD** | **TBD** |
| `settingsThemePreview` | notification | **TBD** | **TBD** | **TBD** | **TBD** |

Build validation must verify every table value against the pinned patch source and verify the matching generated WAV exists in the published asset directory.

---

## 8. Functional Requirements

### FR-1: Event handling

1. The extension must register only the hooks required by Section 7.
2. `agent_settled` is the only completion trigger.
3. `tool_execution_end` is observation-only; the extension must not block or mutate tools.
4. Abort detection must use a session-scoped pending-Esc state plus confirmation that the active run actually aborted. A confirmed abort records that outcome, emits `agentAborted`, suppresses `agentSettled` completion for that run, and clears pending state after settlement or shutdown.
5. All events must pass through the same scheduler, config toggle check, theme mapping lookup, and platform adapter.

### FR-2: Theme and assets

1. Core, Retro, Organic, and Soft must be shipped with the MVP only after Section 7 mappings are complete.
2. Runtime theme selection must take effect immediately for future cues and persist globally.
3. Theme selection must use only generated, packaged assets and never accept arbitrary file paths or URLs.
4. A patch/version update must regenerate WAV assets and rerun mapping validation before publication.

### FR-3: User controls

1. `/audio:config` must be documented in the package README.
2. Changes in Settings UI must be written atomically enough to avoid corrupting the global configuration file.
3. The UI must use Pi’s custom TUI APIs and configured keybinding-aware controls where available.
4. The theme selector must provide the preview/self-test defined in Section 3.3.

### FR-4: Security and privacy

1. Package code and all bundled assets run with the installing user’s permissions; the README must state this clearly.
2. No user-controlled command string, file path, remote URL, or project-local configuration may determine what process runs or what asset plays.
3. The extension must make no network calls at runtime.
4. The extension must not collect, emit, or persist telemetry/log data. The only persisted data is the global user audio configuration.

---

## 9. Implementation Plan

1. **Package foundation**
   - Create npm package metadata, Pi manifest, extension entry point, build scripts, tests, README, license notices, and package-asset inclusion rules.

2. **Patch ingestion and asset build**
   - Pin the selected Core, Retro, Organic, and Soft patch sources.
   - Add the deterministic patch-to-WAV build script.
   - Implement the Section 7 mapping validator and fail builds for missing event/theme assets.

3. **Runtime audio subsystem**
   - Implement configuration read/write and schema migration/version validation.
   - Implement the event scheduler, priority/debounce rules, theme asset resolver, and tracked non-blocking child-process lifecycle.
   - Implement macOS, Linux, and native Windows adapters.

4. **Pi integration**
   - Register lifecycle/tool hooks, mode gating, best-effort abort detection, and session cleanup.
   - Implement `/audio:config` with the approved root menu, individual event toggles, theme selector, preview, and navigation cues.

5. **Verification and packaging**
   - Run automated asset/config/scheduler tests.
   - Perform the platform acceptance matrix in Section 10.
   - Publish a prerelease npm version; verify install, update, disable, and temporary `pi -e` workflows on a clean macOS user profile before wider release.

---

## 10. Acceptance Criteria and Test Matrix

### Core behavior

1. In local TUI mode, one normal, non-aborted agent request produces an agent-start cue and exactly one final completion cue after `agent_settled`.
2. A multi-turn/retry/follow-up run produces no completion cue before final settlement.
3. Each tool failure is eligible for an error cue; failures within one second follow the approved debounce rule.
4. Completion drops pending/colliding lower-priority cues but does not interrupt already heard cues.
5. An Esc press produces an abort cue only when the corresponding active agent run actually aborts; that run does not subsequently produce a completion cue.
6. All in-scope cues are enabled in fresh configuration; each can be disabled and re-enabled through `/audio:config`.
7. Turning all sounds off produces silence; turning all sounds on restores all cues and plays the confirmation cue.
8. Selecting each theme persists the selection, previews its packaged WAV, and affects subsequent cues immediately.

### Package and asset behavior

1. `npm pack` includes the extension code, generated WAV assets, licenses/notices, and required package manifest files.
2. Build validation fails for an undefined event-to-theme patch mapping or missing generated WAV.
3. Package installation and temporary execution work through Pi package mechanisms.
4. Runtime network access is not required or attempted.

### Platform behavior

| Test | macOS | Ubuntu/Debian Linux | Native Windows 10/11 | WSL |
|---|---:|---:|---:|---:|
| Supported player selected | Required | Required | Required | Best effort only |
| Theme preview audible | Required | Required | Required | Not required |
| Agent lifecycle sounds audible | Required | Required | Required | Not required |
| Missing-player failure is non-fatal | Required | Required | Required | Not required |
| Pi TUI/stdout remains clean | Required | Required | Required | Not required |

### Mode and lifecycle behavior

1. JSON, print, RPC, CI, and remote-host configurations emit no audio by default.
2. Player stdout/stderr never appears in Pi output.
3. Reload, session switch, fork, new session, and quit clean up tracked session state without duplicate later cues.
4. No automated test requires actual speakers; adapter invocations and scheduler decisions are unit-testable with mocks.

---

## 11. Owner Review Checklist

Please review and approve or edit the following before implementation begins:

1. **Section 7.2:** Fill in the Core, Retro, Organic, and Soft patch-sound mappings for every event.
2. **Tool-error policy:** Confirm that a one-second debounce means the first error cue plays and subsequent tool errors in that window are coalesced into that one cue, rather than each producing a later queued cue.
3. **Package identity:** Confirm the public npm package name/scope and repository/license metadata.
4. **Configuration file:** Confirm `<agentDir>/pi-extension-sfx.json` (normally `~/.pi/agent/pi-extension-sfx.json`).
5. **Platform contract:** Confirm the supported macOS/native Windows/Ubuntu-Debian matrix and WSL exclusion.
6. **Settings behavior:** Confirm `/audio:config`, the four root options, theme-preview self-test, and mute/re-enable behavior.
7. **Event scope:** Confirm shutdown, generic UI errors, skills, extension commands, and subagent cues remain out of scope for MVP.

---

## 12. Reference Sources

- Pi extension lifecycle, mode, tool, and cleanup semantics: `docs/extensions.md`.
- Pi package manifest and dependency rules: `docs/packages.md`.
- Custom Settings UI patterns and keyboard handling: `docs/tui.md` and `docs/keybindings.md`.
- Pi extension types: `dist/core/extensions/types.d.ts`.
- `@web-kits/audio` patch format and library catalog: https://audio.raphaelsalaja.com/integrations/patches and https://audio.raphaelsalaja.com/library.
- `@web-kits/audio` upstream offline WAV-rendering example: https://github.com/raphaelsalaja/audio.
