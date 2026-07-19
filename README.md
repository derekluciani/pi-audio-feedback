![banner-artwork](assets/media/banner.webp)

`pi-audio-feedback` is an extension for the Pi Agent Harness (TUI mode) that provides short audio cues for common Pi lifecycle events.</br>

This can be useful for those wanting non-visual cues, for example when the agent finishes a task while running in the background.</br>

The extension supports audio cues for the events:
+ `piStart`
+ `agentStart`
+ `agentSettled`
+ `agentAborted`
+ `toolError`
+ `settingsUI`

## Themes
Choose from 4 different audio themes:
+ 🔊 **Core**
+ 🔊 **Retro**
+ 🔊 **Organic**
+ 🔊 **Soft**

<video controls width="720">
  <source src="assets/media/demo.mp4" type="video/mp4">
  Watch demo. Your browser does not support embedded video.
</video>

All sounds are sourced from the [@web-kit/audio](https://audio.raphaelsalaja.com/) library, created by [@raphaelsalaja](https://github.com/raphaelsalaja).</br>

**Build time:** Each sound patch is a `.json` recipe that's synthesized using the `web audio api` and captured as a `.wav` file.

## Install

```sh
pi install npm:pi-audio-feedback
```

## Settings

Run the command in Pi:

```text
/audio:config
```

The user can control the playback of any sound (on/off) and choose from 1 of the 4 available audio themes.

## Compatibility

- **Pi:** 0.80.6+
- **Node.js:** 20+
- **Supported local TUI platforms:**
  - macOS 14+ Apple Silicon 🟢 _tested_
  - Windows 10+ x64, PowerShell 5+ 🟢 _tested_
  - Linux Ubuntu/Debian 22+ x64, PipeWire/PulseAudio ⚫️ _not tested_
  - WSL is explicitly unsupported.
- Audio is intentionally unavailable in non-TUI modes, including RPC, JSON, and print mode. Audio is
also suppressed in CI and SSH sessions. WSL, remote-host and remote-client playback, and other
non-interactive environments are unsupported.

## License and notices

Package code are licensed under the MIT License. See [`LICENSE`](LICENSE).\
Licenses and attribution for third-party material used by bundled or generated
assets are distributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
