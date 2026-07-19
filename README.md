# pi-audio-feedback

Extension for the Pi Agent Harness that provides short audio cues for common Pi lifecycle events.

## Install

```sh
pi install npm:pi-audio-feedback
```

## Audio Settings

Run the command from an idle Pi TUI:

```text
/audio:config
```

The settings interface controls event cues and the active built-in audio theme.

## Compatibility

- **Pi:** `@earendil-works/pi-coding-agent >=0.80.6 <1.0.0`
- **Node.js:** `>=20`
- **Supported local TUI platforms:**
  - macOS 14+ Apple Silicon, Intel
  - Windows 10+ x64, Windows PowerShell 5+
  - Linux Ubuntu/Debian 22+ x64, PipeWire/PulseAudio
  - WSL is explicitly unsupported.
- Audio is intentionally unavailable in non-TUI modes, including RPC, JSON, and print mode. Audio is
also suppressed in CI and SSH sessions. WSL, remote-host and remote-client playback, and other
non-interactive environments are unsupported.

## License and notices

Package code, generated WAV files, and package documentation are licensed under the MIT License. See
[`LICENSE`](LICENSE). Licenses and attribution for third-party material used by bundled or generated
assets are distributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
