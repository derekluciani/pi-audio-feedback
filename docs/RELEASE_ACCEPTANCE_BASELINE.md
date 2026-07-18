# Release Acceptance Baseline

This maintained checklist is the automated evidence map for the current release checkout. The
repository implementation, tests, package contracts, and this document—not the historical MVP
PRD—define the active baseline. Test names are stable evidence identifiers, not audibility claims.
Any row marked **`human-gate`** must be performed and recorded by a person; automated agents skip it
and must not report that a cue was heard.

## Deterministic scheduler

| Row                                                                  | Automated evidence                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. zero-tool `agentStart` → `agentSettled`                           | `tests/scheduler.test.ts` — `runs a normal zero-tool prompt as agentStart then agentSettled`; assembled hooks: `tests/extension.test.ts` — `registers the minimum public hook surface and runs exact normal lifecycle sequence`                                                                                                                                                              |
| 2. tool failures at 0/999/1000 ms                                    | `tests/scheduler.test.ts` — `coalesces 0/999 and opens a new tool-error window at exactly 1000ms`                                                                                                                                                                                                                                                                                            |
| 3. completion while navigation plays                                 | `tests/scheduler.test.ts` — `replaces pending navigation or tool error with completion without killing playback` (navigation parameter)                                                                                                                                                                                                                                                      |
| 4. completion replaces pending tool error                            | Same parameterized test (tool-error parameter)                                                                                                                                                                                                                                                                                                                                               |
| 5. retry/compaction/steering/follow-up starts; final completion only | `tests/scheduler.test.ts` — `drives exact retry, auto-compaction, steering, follow-up, and final sequences`; assembled hooks: `tests/extension.test.ts` — `observes tool errors promptly without mutation and emits every low-level start`                                                                                                                                                   |
| 6. Esc while idle/Settings                                           | Idle state: `tests/scheduler.test.ts` — `ignores literal Escape while idle/settings and for non-aborted outcomes`; real Settings/TUI boundary: `tests/privacy.test.ts` — `opens Settings while idle and treats raw literal Escape as additive, never an abort`                                                                                                                               |
| 7. Esc plus non-aborted message                                      | Same test                                                                                                                                                                                                                                                                                                                                                                                    |
| 8. Esc plus aborted message gives abort only                         | `tests/scheduler.test.ts` — `requests one abort and no completion only for literal-Escape confirmed abort`; assembled hooks: `tests/extension.test.ts` — `requires same-generation literal Escape plus exact final aborted assistant outcome`                                                                                                                                                |
| 9. queued ordinary cue uses current config/theme                     | `tests/scheduler.test.ts` — `uses current config/theme at launch and retains a validated preview candidate`                                                                                                                                                                                                                                                                                  |
| 10. unsaved preview candidate retained                               | Same test; eligibility boundary: `tests/eligibility.test.ts` — `retains only a validated Settings preview candidate`                                                                                                                                                                                                                                                                         |
| 11. accepted toggle-off survives disabling all                       | `tests/scheduler.test.ts` — `requires the opaque accepted proof and survives disabling all toggles`                                                                                                                                                                                                                                                                                          |
| 12. disabled tool error does not affect debounce                     | `tests/scheduler.test.ts` — `disabled errors neither open nor extend the debounce window`                                                                                                                                                                                                                                                                                                    |
| 13. rapid Settings feedback is latest-wins                           | `tests/scheduler.test.ts` — `starts only the newest eligible cue from a rapid burst and never overlaps children`; automatic isolation/order: `keeps automatic playback and precedence while replacing pending Settings across priorities`                                                                                                                                                    |
| 14. Settings supersession cleanup and stale-boundary safety          | `tests/scheduler.test.ts` — `invalidates eligibility and duration continuations without stale launches or preview notices`, `cleans a spawned preview watchdog, contains kill failure, and ignores captured late events`, `keeps the newest request installed across reentrant watchdog cleanup and kill`, and `defers a reentrant pre-spawn replacement until the returned child is killed` |

The complete scheduler queue contract is additionally covered by
`implements every scheduler queue row while retaining older equal-priority automatic work`. Equal
priority retains the older pending request for non-Settings work; pending Settings feedback instead
uses the latest-wins policy above.

## Configuration

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
| failed write / rename and temp cleanup   | parameterized `closes and removes the same-directory temp after a failed ...`                                                                                              |
| protected-path pre-rename temp cleanup   | `removes its temp and preserves a protected path introduced before rename`                                                                                                 |
| atomic replace / temporary-file flush    | `writes, flushes, closes, and atomically renames a unique same-directory temp`                                                                                             |
| POSIX directory flush / close            | parameterized `opens, syncs, and closes the containing directory after rename on POSIX (...)`; Windows skip: `does not open or flush the containing directory on Windows`  |
| last-writer-wins re-read                 | `re-reads before every serialized mutation for completed last-writer-wins behavior`                                                                                        |
| session reload                           | `reloads disk changes for a later session`; assembled contexts: `tests/extension.test.ts` — `reloads disk config for every context and requests appStart only for startup` |
| invalid/unsupported not auto-overwritten | malformed/older tests assert unchanged load; newer, unreadable, and symlink tests assert preservation/rejection                                                            |

## Assets and package

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

## Platform acceptance

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

## Privacy, output, and resource containment

- Closed static runtime graph and player boundary: `tests/privacy.test.ts` recursively parses every
  published `src/**/*.ts` file with the TypeScript compiler AST; the asserted eight-file set is the
  same extension set required by the 66-file pack snapshot in `tests/package-install.test.ts`.
  Imports may name only the two Pi peers, the exact Node built-ins used by production, or relative
  modules resolving inside that scanned set. Import-equals and dynamic import are forbidden. The
  product's unused global/reflection roots (`globalThis`, `global`, `window`, `navigator`,
  `Reflect`, `Proxy`, `eval`, `Function`, and `WebAssembly`) are rejected entirely, as are forbidden
  loader/network names, constructor/prototype escapes, Object aliasing/reflection, and computed
  Object/loader access; production Object use is limited to `freeze`, `fromEntries`, and `keys`.
  Adversarial fixtures cover aliases/destructuring, concatenated keys, Reflect get/apply, Object
  descriptors, indirect eval/Function, Proxy, dynamic loaders, and every mocked network built-in.
- Closed subprocess contract: before applying the general module allowlist, the same analyzer
  inspects import declarations, named and star re-exports, import-equals, import types, dynamic
  imports, `require()` calls, and string-named module declarations in every published extension
  module. Every bare, `node:` or subpath `child_process` reference is rejected except the exact
  named `spawn as nodeSpawn` plus type-only `SpawnOptions` import in `src/platform-adapters.ts`;
  direct re-exports are never allowed. The imported value binding may occur only in that import and
  as `selectPlatformPlayer`'s default `SpawnPlayer` initializer, so local exports, exported
  assignments, aliases, namespace imports, and other uses fail. All four boundary calls and common
  options are AST-matched to the maintained exact `afplay`, `paplay`, `aplay`, and `powershell.exe`
  executable/argument contracts. Single-file mutations and published-graph two-file mutations
  (direct, renamed, star, and imported-binding re-exports plus a relative importer's dormant `curl`
  launch) must fail through the acceptance analyzer.
- Dynamic offline boundary: before production extension import, the same test hoists throwing,
  counting mocks for global `fetch` and the entry APIs of `node:http`, `node:https`, `node:http2`,
  `node:net`, `node:tls`, `node:dns`, `node:dns/promises`, and `node:dgram`. The separate
  `tests/package-install.test.ts` retains real minimum-Pi/package-loader evidence.
- The assembled production-extension matrix runs session hooks for successful `close(0)`, nonzero
  `close(7)`, synchronous launch throw, and asynchronous pre-spawn `error`; runs malformed real
  configuration and missing packaged assets through session/Settings; and reaches an injected real
  `ConfigurationStore` rename failure from Settings. The rename fixture asserts unchanged disk and
  in-memory toggles, one notice, and exactly the accepted pre-save toggle-off request with no
  post-save cue.
- Every assembled case captures `console.log/info/warn/error/debug/trace`, stdout, stderr, and
  unhandled promise rejections and asserts no output/rejection. Dynamic network counters remain
  zero.
- Resource cleanup is observed without product diagnostics: injected timer ownership, fake-child
  listener sets and kill behavior, custom-component promises/counts, command singleton behavior, and
  raw terminal listener disposers. Tests close then reopen Settings to prove its singleton clears,
  and shut down while Settings is open to prove disposal, no stale controller, and a fresh
  next-session component. Player close/error and shutdown leave no test-owned timers or child
  listeners.

- Exact ignored player stdio and platform argument contracts remain independently covered by
  `tests/platform-adapters.test.ts` —
  `uses ignored stdio so success, errors, and nonzero closes cannot leak output`.

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

## Manual release record

Before prerelease publication, attach a dated human test record for the `human-gate` rows above,
including machine architecture, OS version, player/server, preview result, and lifecycle result.
Apple Silicon, Ubuntu PipeWire/PulseAudio, and Windows are release gates. Intel is best effort; ALSA
is recorded when available. WSL is unsupported. Audibility is never an automated-agent completion
criterion.
