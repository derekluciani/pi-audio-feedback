

`pi-audio-feedback` is an extension for the Pi Agent Harness (TUI only) that provides short audio cues for common Pi lifecycle events.</br>

This can be useful for those wanting non-visual cues, for example when the agent finishes a task while running in the background.</br>

The extension supports audio cues for the events:
+ `agentStart`
+ `agentSettled`
+ `agentAborted`
+ `toolError`
+ `settings`

## Themes
Choose from 4 different audio themes:
+ 🔊 **Core**
+ 🔊 **Retro**
+ 🔊 **Organic**
+ 🔊 **Soft**

All sounds are sourced from the [@web-kit/audio](https://audio.raphaelsalaja.com/) library, created by [@raphaelsalaja](https://github.com/raphaelsalaja).\
`pi-audio-feedback` captures each sound patch at build time and ships each sample as a `.wav` file.

## Install

```sh
pi install npm:pi-audio-feedback
```

## Settings

Run the command from pi TUI input:

```text
/audio:config
```

The user can control the playback of any sound (on/off) and choose from 1 of the 4 available audio themes.

## Compatibility

- **Pi:** `@earendil-works/pi-coding-agent >=0.80.6 <1.0.0`
- **Node.js:** `>=20`
- **Supported local TUI platforms:**
  - macOS 14+ Apple Silicon 🟢 _tested_
  - Windows 10+ x64, Windows PowerShell 5+ 🟢 _tested_
  - Linux Ubuntu/Debian 22+ x64, PipeWire/PulseAudio ⚫️ _not tested_
  - WSL is explicitly unsupported.
- Audio is intentionally unavailable in non-TUI modes, including RPC, JSON, and print mode. Audio is
also suppressed in CI and SSH sessions. WSL, remote-host and remote-client playback, and other
non-interactive environments are unsupported.

## License and notices

Package code are licensed under the MIT License. See [`LICENSE`](LICENSE).\
Licenses and attribution for third-party material used by bundled or generated
assets are distributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
