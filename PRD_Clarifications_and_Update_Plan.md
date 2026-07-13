# Pi SFX Extension — Clarifications and PRD Update Plan

**Status:** Requirements consolidated — owner review pending

**Purpose:** Capture follow-up questions resulting from the approved owner decisions and Section 6 event requirements in [PRD_sfx_extension.md](PRD_sfx_extension.md). Once answered, these inputs will be incorporated into the requirements source of truth: [Extension_PRD_Planning.md](Extension_PRD_Planning.md).

---

## Important Feasibility Findings

- Verified: `@web-kits/audio` is a Web Audio/browser runtime library. Its patches are JSON sound definitions, not prebuilt audio files. It supports offline rendering; the upstream project uses a Node Web Audio polyfill to render patches into WAV files. This makes build-time WAV generation viable, but Pi still needs OS-specific playback adapters to send those WAVs to speakers.
- Pi provides no generic event for “a command showed an error” or “a command was invoked.”
- Pi has no dedicated abort event. An abort cue can be approximated from Esc input plus an aborted final agent message.
- The requested Settings UI can be built as this extension’s own `/audio:config` custom TUI. Its navigation events are controllable there, but cannot be attached to Pi’s built-in `/settings` UI.
- Pi has no documented built-in `/extension` command, and `subagent` is not a guaranteed built-in tool—it is commonly supplied by an extension.

---

## Clarifications Needed

<table>
  <thead>
    <tr>
      <th>Clarification ID</th>
      <th>Related owner decision / requirement</th>
      <th>Clarification / decision needed</th>
      <th>Why it matters</th>
      <th>Owner response</th>
      <th>Follow-up response</th>
      <th>Owner response (follow-up)</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>C-01</td>
      <td>D-08</td>
      <td>
        <strong>Audio architecture:</strong> Must <code>@web-kits/audio</code> be the runtime playback engine, or only the source of theme/patch definitions?
        <br><br>
        If it is required at runtime, may the package add a Node-compatible Web Audio backend/polyfill, or should it render/export audio and invoke OS-specific players?
      </td>
      <td><code>@web-kits/audio</code> is browser/Web-Audio oriented and is not a confirmed Node terminal playback solution. This determines the core implementation architecture and cross-platform strategy.</td>
      <td>I am not sure if `@web-kits/audio` is a runtime playback engine. I do know it leverages the "Web Audio" API. Here is the link to their docs: https://audio.raphaelsalaja.com/llms.txt. Please investigate further and provide a recommendation based on my goal of plugging into a library of ready-made sounds. Ideally we could leverage this library and serve it across any platform. Is there a technical challenge here? If so, please explain cleary, I am not an engineer by profession.</td>
      <td><strong>Finding:</strong> In a web browser, this library is a runtime playback engine: it creates an <code>AudioContext</code> and sends sound to the browser's audio system. Pi is a Node.js terminal application, not a browser, so that built-in browser audio system is absent.<br><br><strong>What the library gives us:</strong> ready-made, versioned sound <em>recipes</em> (JSON patches), not generally prebuilt WAV files. Its own project demonstrates a viable bridge: use a Node Web Audio polyfill to render each recipe into a WAV file during a build step.<br><br><strong>Recommendation:</strong> use the library and its curated patches at package-build time; bundle the generated WAVs in this npm package; at runtime, play those WAVs through a small macOS/Linux/Windows adapter. This preserves the ready-made library sounds, requires no network access, and avoids trying to synthesize Web Audio live inside Pi.<br><br><strong>Technical challenge:</strong> WAV generation solves sound creation, but Node still has no single cross-platform “send this WAV to speakers” API. The adapter must use each operating system's audio facility. This is manageable, but it requires defined platform support and tests.<br><br><strong>Decision requested:</strong> approve the build-time patch-to-WAV approach rather than live Web Audio synthesis in Pi.</td>
      <td>Build-time patch-to-WAV approach approved. I assume we can reliably define the spec for each platform but whats the easiest way to test on the users computer? (macosx platform)</td>
    </tr>
    <tr>
      <td>C-02</td>
      <td>D-08, D-09</td>
      <td>
        <strong>Theme packages:</strong> Are <strong>Core</strong>, <strong>Minimal</strong>, and <strong>Retro</strong> existing published patch packages, or theme libraries this package must create and publish?
        <br><br>
        Which theme is the default? Must every theme supply every event sound? If a cue is absent, should Core be used as a fallback or should playback be silent?
      </td>
      <td>The extension needs a stable, testable theme schema and fallback policy before it can map events to sound assets/patches.</td>
      <td>They are published patch packages with audio files that share the same naming conventions across all patches. (ex: patch_name: core, event_settled: notification.wav | pathch_name: retro, event_settled: notification.wav). This sets us up well for theme support. See all available patch libraries: https://audio.raphaelsalaja.com/library</td>
      <td><strong>Verified:</strong> the library registry lists <code>core</code>, <code>minimal</code>, <code>retro</code>, and other patches. The documented patch format is JSON sound definitions; the extension's build will convert the selected patches to WAVs. The Pi event names (for example, <code>agent_settled</code>) remain this extension's mapping layer, while patch names are sound names such as <code>notification</code>, <code>success</code>, or <code>error</code>.<br><br><strong>Requirement:</strong> define one central event-to-patch-sound map and validate at build time that every supported theme supplies every required sound. That is safer than discovering a missing sound while Pi is running.<br><br><strong>Still needed:</strong> choose the default theme. Recommended default: <code>core</code>. Recommended missing-sound policy: reject an incomplete curated theme at build time; use a Core fallback only if a later theme intentionally supports partial coverage.</td>
      <td>I want a "event-to-theme-patch" table in the PRD Planning file where i can specify the patch name mapping to an event per theme. Default theme = Core. Other theme's supported for MVP = Retro, Organic, Soft</td>
    </tr>
    <tr>
      <td>C-03</td>
      <td>D-07, D-13, Section 6</td>
      <td>
        <strong>Default enablement:</strong> Does “all enabled” mean every Section 6 event—including startup, shutdown, Settings UI navigation, <code>/skill</code>, and subagent invocation—is enabled immediately after installation?
        <br><br>
        Should every event have an independent setting toggle?
      </td>
      <td>This determines default behavior, the settings data model, and whether the package may be unexpectedly noisy after installation.</td>
      <td>Yes, let's enable all by default. I will want to test how this plays out once built - If i find the result is overly noisy, I will consider turning some off by default. Regarding independent setting toggles - Reference "owner response" in ID: C-09.</td>
      <td><strong>Recorded:</strong> all in-scope MVP sounds are enabled after installation. “Edit individual sounds playback” in C-09 will provide per-event toggles. The requirements and test plan will treat the initial enabled set as provisional and make it easy to revise after usability testing.</td>
      <td></td>
    </tr>
    <tr>
      <td>C-04</td>
      <td>D-04, D-11</td>
      <td>
        <strong>Tool-error behavior:</strong> D-04 is “Yes.” Should each failed tool play a cue, or should all failures within one agent run produce one consolidated error cue?
        <br><br>
        What debounce interval should apply (for example, 1–2 seconds)? Should an error suppress the normal completion cue for that run?
      </td>
      <td>Parallel tools can fail nearly simultaneously. A defined grouping and priority policy prevents an uncontrolled burst of sounds.</td>
      <td>All tool failures should play a cue. 1 second debounce interval. Normal agent completition run cue should be priority cue and suppress all other cues.</td>
      <td><strong>Recorded:</strong> each failed tool is eligible for an error cue, with a one-second debounce. <strong>One policy detail remains ambiguous:</strong> tool errors normally occur before the final completion sound. A completion sound cannot undo an error the user already heard.<br><br><strong>Recommended interpretation:</strong> play debounced error cues when they occur; when Pi settles, play the completion cue and suppress only lower-priority cues that are pending or would collide with it at that moment. Please confirm this interpretation, or specify that a completion sound should prevent all error sounds for the entire run.</td>
      <td>Interpretation approved</td>
    </tr>
    <tr>
      <td>C-05</td>
      <td>D-03, Section 6</td>
      <td>
        <strong>Abort cue:</strong> Confirm the required behavior is: play a cue only when the user presses Esc during an active agent run and Pi actually aborts.
        <br><br>
        Is the approximate detection strategy acceptable, since Pi does not expose a public event for its displayed “Operation aborted” message?
      </td>
      <td>The extension cannot bind directly to that system message. This decides whether best-effort detection is acceptable.</td>
      <td>Yes, play a cue only when the user presses ESC...Pi actually aborts. It's surprising that the Pi team does not expose "operation aborted" as a public event. Is this surprising?</td>
      <td><strong>Recorded:</strong> use best-effort detection only after Esc is pressed during an active run and the run actually ends as aborted.<br><br><strong>Is it surprising?</strong> Not especially. Pi exposes stable agent and tool lifecycle hooks rather than every TUI message; UI wording can change, and a generic “message shown” hook would be less reliable. A structured <code>agent_aborted</code> event with an abort reason would still be a useful Pi enhancement request because it would remove this heuristic.</td>
      <td></td>
    </tr>
    <tr>
      <td>C-06</td>
      <td>Section 6 (new requirement)</td>
      <td>
        <strong><code>Error: {string}</code> event:</strong> Please provide one concrete reproduction/example command.
        <br><br>
        Does this mean errors from this extension’s commands only, unknown/built-in Pi slash commands, tool failures, model failures, or all of them?
      </td>
      <td>There is no single public Pi hook for all command/UI errors. The exact error source determines whether the cue is technically observable.</td>
      <td>I cannot reproduce my example unfortunately. Maybe we move this to out-of-scope for now? Question: Do you think the Pi team should support hooks for all UI errors?</td>
      <td><strong>Recorded:</strong> generic <code>Error: {string}</code> UI feedback is out of scope for MVP.<br><br><strong>Pi API recommendation:</strong> Pi should not necessarily expose every transient UI/rendering error, which could be noisy, unstable, or duplicate existing signals. More useful additions would be structured, narrowly scoped hooks such as <code>agent_aborted</code> (with reason) and <code>command_failed</code> (command name and safe error code). Tool failures are already observable through <code>tool_execution_end.isError</code>.</td>
      <td></td>
    </tr>
    <tr>
      <td>C-07</td>
      <td>Section 6 (new requirement)</td>
      <td><strong>Shutdown behavior:</strong> Should the shutdown cue apply only to typed <code>/quit</code>, or to every Pi exit path such as <code>Ctrl+D</code> and termination signals?</td>
      <td>Pi reliably exposes shutdown, but its public lifecycle data may not identify the exact command that caused every exit.</td>
      <td>Let's support cmd "/quit" only for MVP</td>
      <td><strong>Blocking API limitation:</strong> the public <code>session_shutdown</code> event reports <code>reason: "quit"</code> for all normal exits; it does not identify whether <code>/quit</code>, <code>Ctrl+D</code>, or a signal caused it. A strict “only typed <code>/quit</code>” cue is therefore not reliably implementable with the public extension API.<br><br><strong>Decision needed:</strong> choose either (A) play the shutdown cue for every normal quit, or (B) remove the shutdown cue from the MVP. Recommendation: choose B if the precise <code>/quit</code>-only behavior is important.</td>
      <td>Option B</td>
    </tr>
    <tr>
      <td>C-08</td>
      <td>D-02, D-06, Section 6</td>
      <td>
        <strong>Skill, extension, and subagent cues:</strong>
        <br><br>
        <ul>
          <li><code>/skill</code>: play when <code>/skill:name</code> is submitted, or only after a known skill successfully expands?</li>
          <li><code>/extension</code>: what exact command, tool, or workflow does this refer to?</li>
          <li><code>subagent</code>: play when a tool named <code>subagent</code> starts, settles, or errors? Is compatibility with the bundled/example subagent extension sufficient?</li>
        </ul>
      </td>
      <td>These are not all first-class, universally observable Pi lifecycle events. Precise timing and integration targets are required.</td>
      <td>If we cannot reliably hook into these events let's make all "out-of-scope" for MVP, including my bundled extensions.</td>
      <td><strong>Recorded:</strong> the <code>/skill</code>, <code>/extension</code>, and <code>subagent</code> cues are out of scope for MVP. This does <em>not</em> remove the reliable core Pi events already approved, such as agent start, agent settlement, tool failure, startup, and best-effort abort detection.</td>
      <td></td>
    </tr>
    <tr>
      <td>C-09</td>
      <td>D-13, Section 6</td>
      <td>
        <strong>Settings UI:</strong> Confirm the command name is <code>/audio:config</code>.
        <br><br>
        Confirm the root menu and submenus. Suggested root items: <strong>Master audio</strong>, <strong>Theme</strong>, <strong>Event toggles</strong>, and <strong>Advanced</strong>.
        <br><br>
        Should Settings UI navigation sounds still play when master audio is disabled, so the user can hear the interface while re-enabling it?
      </td>
      <td>This defines the custom TUI state machine, settings navigation cues, and persistence behavior.</td>
      <td>What is "master audio" in this context? I find this terminology confusing. I want the root level options to be something like: 1. Turn all sounds on, 2. Turn all sounds off, 3. Edit individual sounds playback. 4. Select Audio Theme. Within option #3, the user can decide to toggle individual audio events. What would be in "Advanced" menu?</td>
      <td><strong>Terminology:</strong> “master audio” meant one global on/off switch. Your labels are clearer and will replace it.<br><br><strong>Proposed MVP root menu:</strong> <ol><li>Turn all sounds on</li><li>Turn all sounds off</li><li>Edit individual sound playback</li><li>Select Audio Theme</li></ol>There is no need for an <strong>Advanced</strong> menu in MVP: volume is OS-controlled, the debounce is fixed, custom paths are excluded, and diagnostics/telemetry are excluded.<br><br><strong>Recommended behavior:</strong> when all sounds are off, navigation is silent; selecting “Turn all sounds on” enables audio first, then plays its confirmation cue. Please confirm the command name <code>/audio:config</code> and this mute/re-enable behavior.</td>
      <td>Approved</td>
    </tr>
    <tr>
      <td>C-10</td>
      <td>D-14, D-15, D-16, D-17, D-18</td>
      <td>
        <strong>Cross-platform policy:</strong> Define the required test matrix: macOS, Linux distributions/audio stacks, native Windows, and/or WSL.
        <br><br>
        May the extension require an installed OS audio player, or must the npm package provide playback without an external-player prerequisite?
      </td>
      <td>“All OS Pi supports” must become a precise support contract. The answer drives packaging, dependencies, player adapters, and test coverage.</td>
      <td>I am not familiar with this technical area. I need clear explanations of what's involved, pros/cons, trade-offs, overall recommendation.</td>
      <td><strong>What is involved:</strong> the extension needs (1) WAV files to play and (2) a way for the operating system to send those files to speakers. Pre-rendering the library patches handles (1); each OS handles (2) differently.<br><br><strong>Option A — OS player adapters (recommended):</strong> invoke the OS's available player for a bundled WAV: macOS <code>afplay</code>; Linux <code>paplay</code> with <code>aplay</code> fallback; Windows PowerShell/.NET WAV playback. <em>Pros:</em> small package, no native binaries bundled, straightforward, and compatible with a published npm package. <em>Cons:</em> Linux varies by distribution and a player may be absent.<br><br><strong>Option B — ship a Node/native audio engine:</strong> one dependency attempts playback everywhere. <em>Pros:</em> fewer external-player assumptions. <em>Cons:</em> platform-specific native binaries, larger installs, more installation failures, and substantially more maintenance. It does not remove all driver/device differences.<br><br><strong>Recommendation:</strong> support macOS, native Windows 10/11, and Ubuntu/Debian Linux with PipeWire/PulseAudio or ALSA fallback for MVP; treat WSL as best-effort/unsupported until tested. Bundle generated WAVs and use Option A. If no supported player is available, remain silent and show an optional Settings UI diagnostic—not an error that disrupts Pi.<br><br><strong>Decision needed:</strong> approve this support matrix and external-player policy, or name a different required Linux/Windows/WSL matrix.</td>
      <td>Option A and recommendation approved</td>
    </tr>
  </tbody>
</table>

---

## Plan to Update `Extension_PRD_Planning.md`

The requirements source of truth has now been updated in [Extension_PRD_Planning.md](Extension_PRD_Planning.md). Approved responses have been incorporated as follows:

- C-01: build-time `@web-kits/audio` patch-to-WAV pipeline approved; the Settings UI theme preview is the primary macOS user self-test.
- C-02: Core is the default; Retro, Organic, and Soft are MVP themes. Section 7.2 of the requirements file is the owner-editable event-to-theme-patch mapping table.
- C-04: tool errors use a 1,000 ms debounce; final completion suppresses pending/colliding lower-priority cues only.
- C-07: shutdown sound is out of scope for MVP.
- C-08: generic UI errors and skill/extension/subagent cues are out of scope for MVP.
- C-09: `/audio:config`, the four approved root actions, and silent mute/re-enable behavior are specified.
- C-10: OS-player adapters are approved for macOS, native Windows 10/11, and Ubuntu/Debian Linux; WSL is best effort only.

### Next steps

1. **Owner review** — Review the checklist in Section 11 of `Extension_PRD_Planning.md`, especially the event-to-theme-patch mapping table, package identity, config path, and platform contract.
2. **Requirements sign-off** — Record requested edits or approval. Do not begin implementation until mappings are complete, because build validation requires them.
3. **Implementation** — On approval, execute the five phases in Section 9 of `Extension_PRD_Planning.md`.
4. **macOS pilot** — Install the prerelease on a clean macOS user profile, use `/audio:config` → **Select Audio Theme** to test `afplay`, then validate actual agent lifecycle sounds before publishing broadly.
