# PRD §11 Release Acceptance Traceability

This checklist is the automated evidence map for a release checkout. Test names are stable evidence
identifiers, not audibility claims. Any row marked **`human-gate`** must be performed and recorded
by a person; automated agents skip it and must not report that a cue was heard.

## §11.1 Deterministic scheduler

| Row                                                                  | Automated evidence                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. zero-tool `agentStart` → `agentSettled`                           | `tests/scheduler.test.ts` — `runs a normal zero-tool prompt as agentStart then agentSettled`; assembled hooks: `tests/extension.test.ts` — `registers the minimum public hook surface and runs exact normal lifecycle sequence`               |
| 2. tool failures at 0/999/1000 ms                                    | `tests/scheduler.test.ts` — `coalesces 0/999 and opens a new tool-error window at exactly 1000ms`                                                                                                                                             |
| 3. completion while navigation plays                                 | `tests/scheduler.test.ts` — `replaces pending navigation or tool error with completion without killing playback` (navigation parameter)                                                                                                       |
| 4. completion replaces pending tool error                            | Same parameterized test (tool-error parameter)                                                                                                                                                                                                |
| 5. retry/compaction/steering/follow-up starts; final completion only | `tests/scheduler.test.ts` — `drives exact retry, auto-compaction, steering, follow-up, and final sequences`; assembled hooks: `tests/extension.test.ts` — `observes tool errors promptly without mutation and emits every low-level start`    |
| 6. Esc while idle/Settings                                           | `tests/scheduler.test.ts` — `ignores literal Escape while idle/settings and for non-aborted outcomes`                                                                                                                                         |
| 7. Esc plus non-aborted message                                      | Same test                                                                                                                                                                                                                                     |
| 8. Esc plus aborted message gives abort only                         | `tests/scheduler.test.ts` — `requests one abort and no completion only for literal-Escape confirmed abort`; assembled hooks: `tests/extension.test.ts` — `requires same-generation literal Escape plus exact final aborted assistant outcome` |
| 9. queued ordinary cue uses current config/theme                     | `tests/scheduler.test.ts` — `uses current config/theme at launch and retains a validated preview candidate`                                                                                                                                   |
| 10. unsaved preview candidate retained                               | Same test; eligibility boundary: `tests/eligibility.test.ts` — `retains only a validated Settings preview candidate`                                                                                                                          |
| 11. accepted toggle-off survives disabling all                       | `tests/scheduler.test.ts` — `requires the opaque accepted proof and survives disabling all toggles`                                                                                                                                           |
| 12. disabled tool error does not affect debounce                     | `tests/scheduler.test.ts` — `disabled errors neither open nor extend the debounce window`                                                                                                                                                     |

The complete §6.4 state table is additionally covered by
`implements every PRD 6.4 queue row and retains older equal priority`.

## §11.2 Configuration

| Case                                     | Automated evidence                                                                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| missing / first-run no write             | `tests/config.test.ts` — `uses exact defaults and a global agent-directory path without creating a missing file`                                                           |
| partial / wrong type / unknown theme     | `defaults partial, wrong-type, and unknown-theme fields independently`                                                                                                     |
| malformed and empty                      | parameterized `classifies ... content as replaceable malformed defaults`; output: `does not emit stdout or stderr while loading malformed content`                         |
| unreadable                               | `classifies unreadable paths without leaking filesystem errors and rejects writes`                                                                                         |
| symlink                                  | `rejects symlink paths while preserving the link and target` plus both swap-race tests                                                                                     |
| unknown field/event                      | `preserves unknown root fields and events on valid version-1 writes`                                                                                                       |
| older version                            | parameterized `classifies older version content as replaceable malformed defaults`                                                                                         |
| newer version                            | `preserves a newer version and rejects a destructive downgrade`                                                                                                            |
| first write and POSIX modes              | `creates the first file with a trailing newline and restrictive POSIX permissions`                                                                                         |
| failed write / rename                    | parameterized `retains prior memory and disk state after a failed ...`                                                                                                     |
| atomic replace / flush order             | `writes, flushes, closes, and atomically renames a unique same-directory temp`                                                                                             |
| last-writer-wins re-read                 | `re-reads before every serialized mutation for completed last-writer-wins behavior`                                                                                        |
| session reload                           | `reloads disk changes for a later session`; assembled contexts: `tests/extension.test.ts` — `reloads disk config for every context and requests appStart only for startup` |
| invalid/unsupported not auto-overwritten | malformed/older tests assert unchanged load; newer, unreadable, and symlink tests assert preservation/rejection                                                            |

## §11.3 Assets and package

| Row                                            | Automated evidence / exact command                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. immutable provenance and patch SHA-256      | `tests/assets.test.ts` — `pins renderer settings and immutable patch provenance`; `npm run assets:verify`                                    |
| 2. WAV headers, format, path, manifest SHA-256 | `verifies committed headers, mapped paths, and checksums without regeneration`; `npm run assets:verify`                                      |
| 3. pinned byte-identical regeneration          | CI job `Deterministic assets (Ubuntu 24.04, Node 22.23.1)` — `npm run assets:verify:reproduce`                                               |
| 4. exact pack snapshot                         | `tests/package-install.test.ts` — `has an exact runtime snapshot and loads from a production-only unusual path`; `npm pack --dry-run --json` |
| 5. production-only install                     | Same test uses `npm install --omit=dev --omit=peer --ignore-scripts` and Pi-provided peer aliases                                            |
| 6. spaces and non-ASCII resolution             | Same test installs and imports/registers from `production install with spaces 日本語`; adapter path fixtures cover apostrophes too           |
| 7. Node/Pi matrix                              | CI `Quality (Node 20/22/24)` and `Minimum Pi 0.80.6 compatibility` jobs                                                                      |

The package snapshot requires every extension module, package metadata, notices, helper, WAV
manifest, and every manifest-listed WAV. It rejects every additional path, including tests,
`.web-kits`, patch inputs, build scripts, docs, and test/spec files.

## §11.4 Platform acceptance

| Environment                       | Automated evidence                                                                                                          | Manual requirement                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| macOS 14+ Apple Silicon           | `tests/platform-adapters.test.ts` — macOS argument/path fixtures and `stdio: "ignore"`; run in every Node matrix job        | **`human-gate`**: hear preview and lifecycle cue |
| macOS 14+ Intel                   | Same deterministic `afplay` fixture; automation makes no audibility claim                                                   | **`human-gate`**, best effort and non-blocking   |
| Ubuntu 22.04+ PipeWire/PulseAudio | Linux `paplay` fixture and common spawn options                                                                             | **`human-gate`**: hear preview                   |
| Ubuntu ALSA-only fixture          | `falls back exactly once after asynchronous pre-spawn paplay ENOENT` and synchronous ENOENT fixture                         | **`human-gate`** when fixture is available       |
| Windows 11 / PowerShell 5.1       | `uses exact Windows PowerShell 5.1 executable and separate path arguments`; fixed-helper test in `tests/foundation.test.ts` | **`human-gate`**: hear preview and lifecycle cue |
| WSL                               | `tests/eligibility.test.ts` policy suppression fixtures; README says unsupported                                            | No supported acoustic test                       |

Automated platform fixtures inject `spawn`; they never launch audio and never claim runner OS
audibility.

## §11.5 Privacy, output, and resource containment

- Static closed runtime graph and forbidden `fetch`/HTTP/HTTPS/net/TLS/DNS/datagram checks:
  `tests/privacy.test.ts` —
  `has a closed production import graph with no runtime network primitive`.
- Dynamic load, session, Settings, playback, and shutdown with a failing `fetch` sentinel:
  `loads, runs lifecycle playback, opens Settings, and shuts down offline and silently`.
- Success/nonzero output and exact ignored player stdio: privacy integration plus
  `tests/platform-adapters.test.ts` —
  `uses ignored stdio so success, errors, and nonzero closes cannot leak output`.
- Spawn error, missing asset, malformed config: `tests/privacy.test.ts` —
  `contains malformed config, missing assets, and asynchronous spawn errors`; synchronous spawn
  throw and preview stage isolation are covered by scheduler
  `removes a child ... and continues after launch failure` and
  `notices only approved preview pre-spawn failures and stays silent post-spawn`.
- Failed Settings write stays contained and reverts: `tests/settings.test.ts` —
  `saves individual toggles in the required cue order and reverts failed writes`; filesystem
  write/rename failures are covered in `tests/config.test.ts`.
- Handler promises and expected listener/load failures: `tests/extension.test.ts` —
  `contains malformed-config, listener, and launch failures without output or rejection`.
- No leaked timer/listener/child after normal/error/watchdog/shutdown: scheduler tests
  `incrementally cleans synchronous listener settlement and event orderings`,
  `arms duration+2000 watchdog ...`, and `cleans active listeners and timers ...`; assembled
  extension test
  `installs raw input only in TUI and idempotently cleans listeners, timers, and children`.

## Clean-checkout release commands

Run in this order. npm registry access is installation/build-time only; the tests prohibit product
runtime network paths and never spawn a real audio process.

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run assets:verify
npm pack --dry-run --json
npm audit --omit=dev --audit-level=high
```

Production audit findings must be zero before release. Build-only advisories may be documented with
an upstream reference and non-exploitability rationale, but critical/high findings are never waived
silently.

## PRD §12 step 6 manual record

Before prerelease publication, attach a dated human test record for the `human-gate` rows above,
including machine architecture, OS version, player/server, preview result, and lifecycle result.
Apple Silicon, Ubuntu PipeWire/PulseAudio, and Windows are release gates. Intel is best effort; ALSA
is recorded when available. WSL is unsupported. Audibility is never an automated-agent completion
criterion.
