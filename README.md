# pi-audio-feedback

`pi-audio-feedback` is a Pi package that provides short, local WAV cues for supported Pi lifecycle
events and its audio settings interface.

## Install

```sh
pi install npm:pi-audio-feedback
```

Pi packages run with the installing user's full system permissions and extensions can execute
arbitrary code. Review package source before installation and install only versions you trust. This
package performs no runtime network access; its audio assets are distributed in the npm tarball.

## Compatibility

- **Pi:** `@earendil-works/pi-coding-agent >=0.80.6 <1.0.0`
- **Node.js:** `>=20`
- **Supported local TUI platforms:** macOS 14 or newer, native Windows 10/11 with Windows PowerShell
  5.1, and Ubuntu/Debian Linux with PulseAudio/PipeWire or ALSA playback tools

Audio is intentionally unavailable in non-TUI modes, including RPC, JSON, and print mode. Audio is
also suppressed in CI and SSH sessions. WSL, remote-host and remote-client playback, and other
non-interactive environments are unsupported.

## Configure

Run the following command from an idle local Pi TUI:

```text
/audio:config
```

The settings interface controls event cues and the active built-in audio theme. Invoking the command
outside TUI mode does not open an interface or play audio.

## Release audibility checklist (`human-gate`)

Automated adapter tests verify process selection, arguments, failure handling, and output isolation;
they do not establish audibility. Before release, a human tester records whether they heard the
Settings theme preview and lifecycle cue on required platforms:

- macOS 14+ Apple Silicon: preview and lifecycle cue
- Ubuntu 22.04+ x64 with PipeWire/PulseAudio: preview
- Windows 11 x64 with Windows PowerShell 5.1: preview and lifecycle cue
- Ubuntu ALSA-only fixture: preview when available
- macOS 14+ Intel: best effort when available (not release-blocking)

WSL is explicitly unsupported. These rows remain a `human-gate`; automated agents must not claim
that a cue was heard. The exact automated-to-manual evidence map and human test record requirements
are maintained in [`docs/ACCEPTANCE_TRACEABILITY.md`](docs/ACCEPTANCE_TRACEABILITY.md).

## License and notices

Package code, generated WAV files, and package documentation are licensed under the MIT License. See
[`LICENSE`](LICENSE). Licenses and attribution for third-party material used by bundled or generated
assets are distributed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Asset verification

`npm run assets:verify` is host-independent: it validates the authoritative patch provenance and
checksums, approved mappings and paths, committed WAV headers and formats, manifest hashes, and
artifact completeness without rendering audio. `npm test` uses the same committed-artifact check and
verifies package contents.

Byte-identical regeneration is a release check because renderer output is guaranteed only on the
pinned Ubuntu 24.04 / Node.js 22.23.1 toolchain. The pinned CI job explicitly runs
`npm run assets:verify:reproduce`; do not replace it with the host-independent command. Asset
generation is likewise build/release-only and is not performed on user machines or at runtime.
