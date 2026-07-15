# TypeScript and Node.js Coding Best Practices

Concise baseline for modern TypeScript/Node.js applications and packages.

## General Coding Guidelines

- Always produce **complete, functional code** — not pseudocode or placeholders.  
- Implement an architecture that is flexible enough to handle **feature extensibility** in the future.  
- Always maintain an clear, organized **file structure**.  
- Always adhere to **highly semantic** and **consistent** naming conventions.  
- Always write **thorough comments** for code behavior clarity and easy readability.

## TypeScript

- Enable strict checking: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride`.
- Use ESM consistently; enable `verbatimModuleSyntax` and `isolatedModules`.
- Prefer narrow types, discriminated unions, `unknown` over `any`, and `satisfies` for validated object literals.
- Validate all external input at runtime (configuration, files, network data, and CLI arguments); TypeScript types alone are not validation.
- Keep functions small and explicit. Prefer immutable data and `const`; avoid type assertions unless the invariant is documented.
- Use named types/interfaces for public APIs and document exported functions, options, errors, and side effects.
- Model expected failures explicitly where useful; preserve causes with `new Error(message, { cause })`.
- Avoid `enum` when a string-literal union or `as const` object is sufficient.
- Treat `JSON.parse()` results as `unknown`; validate and narrow them at the boundary before use. Never trust a type assertion to validate external data.
- Use explicit type guards or schema parsers for persisted configuration and other untrusted input.
- Use `filter(Boolean)` only when its narrowing behavior is verified; prefer an explicit type guard when clarity or portability matters.
- Use small, typed membership helpers for readonly arrays and sets when literal-union APIs such as `includes()` or `has()` are too restrictive.
- Do not add global typing resets such as `@total-typescript/ts-reset` to a published library or extension; they can unexpectedly affect consumers. Apply the underlying safer patterns locally instead.

## Node.js

- Target a supported LTS release and declare the minimum version in `engines`; this project targets Node.js 20+.
- Use `node:` imports (`node:fs/promises`, `node:path`, `node:child_process`, etc.).
- Prefer async APIs. Never block the event loop with synchronous I/O in request or lifecycle paths.
- Handle promises deliberately: `await` or return them; do not create floating promises. Use `AbortSignal` for cancellation and timeouts.
- Resolve package assets from the package/module location, not the current working directory.
- For child processes, use `spawn` with argument arrays, `shell: false`, controlled `cwd`/`env`, and intentional stdio handling. Never interpolate user input into shell commands.
- Treat filesystem, process, and environment data as untrusted; use explicit paths, permissions, and size/time limits.
- Clean up timers, listeners, streams, and child processes on shutdown. Make cleanup idempotent.
- Keep runtime network access and dependencies minimal; pin build inputs and generate reproducible artifacts.

## Package and Tooling

- Use `package.json` with `"type": "module"`, explicit `exports`, `files`, `engines`, and a lockfile.
- Separate source, build output, and generated assets; verify `npm pack --dry-run` contains only required runtime files.
- Use ESLint with `typescript-eslint`, consistent formatting (Prettier or an equivalent formatter), and type-check in CI.
- Test behavior at boundaries: malformed input, unavailable dependencies, cancellation, retries, shutdown, and platform differences.
- Run CI across the supported Node versions and platforms; do not claim coverage from tests that only mock platform behavior.
- Review dependencies, audit releases, and avoid secrets or sensitive data in logs, errors, and test fixtures.

## Review Checklist

- [ ] `npm run lint`, formatting, type-check, and tests pass.
- [ ] No `any`, unsafe assertion, floating promise, or unhandled rejection without justification.
- [ ] External input is validated and errors retain useful context without leaking sensitive data.
- [ ] Resources are bounded and cleaned up on success, failure, cancellation, and shutdown.
- [ ] Public APIs and package exports are intentional and documented.
- [ ] The packaged result was inspected with `npm pack --dry-run`.
