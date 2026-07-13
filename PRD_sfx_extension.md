# Pi SFX Extension — Owner Decision Register

**Status:** Awaiting owner decisions

**Purpose:** Record the decisions and resulting implementation outputs for the Pi SFX extension. Requirements and technical audit details are maintained in [Extension_PRD_Planning.md](Extension_PRD_Planning.md).

---

## 1. Product and Event Policy

<table>
  <thead>
    <tr>
      <th>ID</th>
      <th>Decision needed</th>
      <th>Options</th>
      <th>Suggested MVP</th>
      <th>Owner decision / output</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>D-01</td>
      <td>Who is this for?</td>
      <td>Personal/global use; per-project/team use; distributable public package</td>
      <td>Personal/global use</td>
      <td>distributable public package (npm)
</td>
    </tr>
    <tr>
      <td>D-02</td>
      <td>Which completion behavior is required?</td>
      <td>Completion only; completion + start; completion + start + errors</td>
      <td>Completion only</td>
      <td>completion + start + errors
</td>
    </tr>
    <tr>
      <td>D-03</td>
      <td>Should completion play after an aborted run?</td>
      <td>Yes; no; only if final response exists</td>
      <td>No / suppress if recognizable</td>
      <td>No, I want specific audio feedback for aborted runs. See Section 6 for details.</td>
    </tr>
    <tr>
      <td>D-04</td>
      <td>Should known tool failures play a different sound?</td>
      <td>No; yes, one sound per settled run; yes, per failed tool</td>
      <td>No for MVP</td>
      <td>Yes</td>
    </tr>
    <tr>
      <td>D-05</td>
      <td>Should “Pi needs an answer” have a distinct cue?</td>
      <td>No; same completion sound; heuristic distinct sound</td>
      <td>Same completion sound</td>
      <td>Same completion sound</td>
    </tr>
    <tr>
      <td>D-06</td>
      <td>Are tool-level sounds desired?</td>
      <td>Never; configurable; always</td>
      <td>Never by default</td>
      <td>No for MVP</td>
    </tr>
    <tr>
      <td>D-07</td>
      <td>Is audio enabled by default after installation?</td>
      <td>Enabled; disabled until opt-in; prompt once</td>
      <td>Enabled for completion only, with simple mute control</td>
      <td>All enabled; User can toggle off/on in settings UI</td>
    </tr>
  </tbody>
</table>

## 2. Sound and Accessibility Policy

<table>
  <thead>
    <tr>
      <th>ID</th>
      <th>Decision needed</th>
      <th>Options</th>
      <th>Suggested MVP</th>
      <th>Owner decision / output</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>D-08</td>
      <td>Source of sounds</td>
      <td>Bundled assets; OS system sounds; user-provided file paths</td>
      <td>Bundled short assets</td>
      <td>Library dependency: `@web-kits/audio` public api</td>
    </tr>
    <tr>
      <td>D-09</td>
      <td>Sound Themes</td>
      <td></td>
      <td></td>
      <td>Support selectable themes that share the same schema but point to specific audio file patch libraries (ex: Core, Minimal, Retro, etc.) from`@web-kits/audio` library api</td>
    </tr>
    <tr>
      <td>D-10</td>
      <td>Volume control</td>
      <td>OS volume only; extension gain/player option; both</td>
      <td>OS volume only initially</td>
      <td>OS volume only initially</td>
    </tr>
    <tr>
      <td>D-11</td>
      <td>Repeated completion handling</td>
      <td>Play each time; debounce; coalesce into one sound</td>
      <td>Debounce/coalesce</td>
      <td>Debounce/coalesce</td>
    </tr>
    <tr>
      <td>D-12</td>
      <td>Accessibility preference</td>
      <td>Audio only; audio plus visual status; visual fallback</td>
      <td>Audio only; Pi's normal UI remains unchanged</td>
      <td>Audio only</td>
    </tr>
    <tr>
      <td>D-13</td>
      <td>Mute/disabling UX</td>
      <td>Config file only; slash command; shortcut; all</td>
      <td>Slash command plus persisted configuration</td>
      <td>Configurable from 'Settings UI'. See Section 6 for details.</td>
    </tr>
  </tbody>
</table>

## 3. Platform and Deployment Policy

<table>
  <thead>
    <tr>
      <th>ID</th>
      <th>Decision needed</th>
      <th>Options</th>
      <th>Suggested MVP</th>
      <th>Owner decision / output</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>D-14</td>
      <td>Supported operating systems</td>
      <td>macOS only; macOS + Linux; macOS + Linux + Windows</td>
      <td>Declare macOS only unless portability is required</td>
      <td>MVP: macOS, native Windows 10/11, and Ubuntu/Debian Linux. WSL is best effort only. See C-10 approval.</td>
    </tr>
    <tr>
      <td>D-15</td>
      <td>Linux audio backend(s)</td>
      <td>none; <code>paplay</code>; <code>aplay</code>; configurable fallback chain</td>
      <td>Not in macOS-only MVP</td>
      <td>Linux support for MVP</td>
    </tr>
    <tr>
      <td>D-16</td>
      <td>Windows support</td>
      <td>none; PowerShell/.NET; packaged player</td>
      <td>Not in macOS-only MVP</td>
      <td>Windows support for MVP</td>
    </tr>
    <tr>
      <td>D-17</td>
      <td>Remote/RPC policy</td>
      <td>Do not play; play on Pi host; client integration later</td>
      <td>TUI/local host only; do not promise remote-client audio</td>
      <td>TUI/local host only</td>
    </tr>
    <tr>
      <td>D-18</td>
      <td>Distribution format</td>
      <td>Single local <code>.ts</code>; extension directory/package; published Pi package</td>
      <td>Single local <code>.ts</code> for MVP</td>
      <td>Published Pi Package</td>
    </tr>
  </tbody>
</table>

## 4. Configuration and Data Policy

<table>
  <thead>
    <tr>
      <th>ID</th>
      <th>Decision needed</th>
      <th>Options</th>
      <th>Suggested MVP</th>
      <th>Owner decision / output</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>D-19</td>
      <td>Configuration location</td>
      <td>Global user config; project config; environment/CLI flags; combination</td>
      <td>Global user config</td>
      <td>Global user config</td>
    </tr>
    <tr>
      <td>D-20</td>
      <td>Project-specific settings</td>
      <td>Disallow; allow only in trusted projects; always allow</td>
      <td>Disallow for MVP</td>
      <td>Disallow for MVP</td>
    </tr>
    <tr>
      <td>D-21</td>
      <td>Persist runtime toggles</td>
      <td>No; current session only; persist across sessions</td>
      <td>Persist across sessions</td>
      <td>Persist across sessions</td>
    </tr>
    <tr>
      <td>D-22</td>
      <td>Custom file paths</td>
      <td>No; allow absolute files; allow arbitrary commands</td>
      <td>Allow files only if needed; never arbitrary commands</td>
      <td>No; limited to `@web-kits/audio` library api for MVP</td>
    </tr>
    <tr>
      <td>D-23</td>
      <td>Telemetry/logging</td>
      <td>None; local debug log; usage telemetry</td>
      <td>None; optional local debug logging</td>
      <td>None for mvp</td>
    </tr>
  </tbody>
</table>

---

## 5. Minimum Approval Gate

Implementation should not begin until the owner has decided:

- D-01 — audience/distribution scope
- D-02 — MVP event set
- D-07 — default enablement policy
- D-08 — asset source
- D-11 — debounce/overlap policy
- D-13 — user control mechanism
- D-14 through D-17 — platform and remote-use policy
- D-19 and D-21 — configuration location and persistence

### Suggested low-risk MVP output

> Global personal extension; macOS only; TUI/local-host only; enabled completion ping only; bundled short asset; persisted global mute control; 1–2 second completion debounce; no per-tool or error sounds; no remote/RPC guarantee; no telemetry.


## 6. Owner's Additional “Events” with audio feedback — MVP disposition

The clarification outcomes in [PRD_Clarifications_and_Update_Plan.md](PRD_Clarifications_and_Update_Plan.md) supersede the original raw list below.

Pi Alerts
* “Operation aborted” — **in scope** as best-effort Esc-triggered abort feedback.
* “Error: {string}” — **out of scope for MVP**.

Run/End App
* Pi startup (bash cmd: `pi`) — **in scope**.
* Pi shutdown (Pi cmd: `/quit`) — **out of scope for MVP** because the public extension API cannot reliably distinguish `/quit` from other normal exit paths.

Specific command types
* User commands a `/skill` — **out of scope for MVP**.
* User commands a Pi `/extension` — **out of scope for MVP**.
* A `subagent` is invoked/called — **out of scope for MVP**.

Settings UI (command: `/audio:config`)
The following events should map to existing Pi UI states: 
* Root Directory enter - (key ENTER)
* Root Directory exit - (key ESC)  
* Sub Directory selection - (key ENTER)
* Sub Directory exit - (key ESC)
* Option list - navigate (key up/down)
* Option selection - toggle (key ENTER)
* Option selection - radio/checkbox (key ENTER)
