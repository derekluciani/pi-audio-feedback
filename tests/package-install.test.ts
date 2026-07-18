import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

type PackFile = { path: string };
type PackResult = { filename: string; files: PackFile[] };

const temporaryDirectories: string[] = [];
const REQUIRED_EXTENSION_FILES = [
  "src/audio-catalog.ts",
  "src/config.ts",
  "src/eligibility.ts",
  "src/index.ts",
  "src/platform-adapters.ts",
  "src/scheduler.ts",
  "src/settings.ts",
  "src/terminal-outcomes.ts",
] as const;
const REQUIRED_PACKAGE_METADATA = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "scripts/play-wav.ps1",
] as const;
const FORBIDDEN_PACKAGE_PREFIXES = [
  ".github/",
  ".pi/",
  ".web-kits/",
  "_ignore/",
  "assets/patches/",
  "docs/",
  "scripts/assets/",
  "tests/",
] as const;

function parsePackResult(output: string): PackResult {
  const value: unknown = JSON.parse(output);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new TypeError("npm pack must return one package result");
  }

  const result: unknown = value[0];
  if (typeof result !== "object" || result === null) {
    throw new TypeError("npm pack result must be an object");
  }

  const filename = "filename" in result ? result.filename : undefined;
  const files = "files" in result ? result.files : undefined;
  if (typeof filename !== "string" || !Array.isArray(files)) {
    throw new TypeError("npm pack result is missing filename or files");
  }

  const validatedFiles = files.map((file: unknown): PackFile => {
    if (typeof file !== "object" || file === null) {
      throw new TypeError("npm pack file entry must be an object");
    }
    const path = "path" in file ? file.path : undefined;
    if (typeof path !== "string") {
      throw new TypeError("npm pack file entry must have a path");
    }
    return { path };
  });

  return { filename, files: validatedFiles };
}

function parseWavManifest(source: string): string[] {
  const value: unknown = JSON.parse(source);
  if (
    typeof value !== "object" ||
    value === null ||
    !("files" in value) ||
    typeof value.files !== "object" ||
    value.files === null ||
    Array.isArray(value.files)
  ) {
    throw new TypeError("WAV manifest must contain a files object");
  }
  return Object.keys(value.files);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("published package", () => {
  it("has an exact runtime snapshot and loads from a production-only unusual path", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-audio-feedback-"));
    temporaryDirectories.push(root);
    const directory = join(root, "production install with spaces 日本語");
    await mkdir(directory, { recursive: true });

    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
      encoding: "utf8",
    });
    const packed = parsePackResult(output);
    const paths = packed.files.map((file) => file.path).sort();
    const wavManifestSource = await readFile(
      new URL("../assets/wav/manifest.json", import.meta.url),
      "utf8",
    );
    const wavFiles = parseWavManifest(wavManifestSource);
    const expectedPaths = [
      ...REQUIRED_PACKAGE_METADATA,
      ...REQUIRED_EXTENSION_FILES,
      "assets/wav/manifest.json",
      ...wavFiles,
    ].sort();

    expect(paths).toEqual(expectedPaths);
    for (const prefix of FORBIDDEN_PACKAGE_PREFIXES) {
      expect(
        paths.some((path) => path.startsWith(prefix)),
        prefix,
      ).toBe(false);
    }
    expect(
      paths.some((path) => /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$/.test(path)),
    ).toBe(false);

    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "production-fixture", private: true }),
      "utf8",
    );
    execFileSync(
      "npm",
      [
        "install",
        "--omit=dev",
        "--omit=peer",
        "--ignore-scripts",
        "--legacy-peer-deps",
        join(directory, packed.filename),
      ],
      { cwd: directory, stdio: "ignore" },
    );

    const installedManifest = await readFile(
      join(directory, "node_modules", "pi-audio-feedback", "package.json"),
      "utf8",
    );
    expect(installedManifest).toContain('"name": "pi-audio-feedback"');

    // Pi supplies these public peers. Root-only aliases model that loader boundary and reject
    // accidental use of private Pi/TUI subpaths from the assembled production package.
    const suppliedPiDirectory = join(
      directory,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await mkdir(suppliedPiDirectory, { recursive: true });
    await writeFile(
      join(suppliedPiDirectory, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "utf8",
    );
    await writeFile(
      join(suppliedPiDirectory, "index.js"),
      `
        export const getAgentDir = () => {
          globalThis.__PI_PUBLIC_GET_AGENT_DIR_CALLS__ =
            (globalThis.__PI_PUBLIC_GET_AGENT_DIR_CALLS__ ?? 0) + 1;
          const directory = process.env.PI_TEST_AGENT_DIR;
          if (directory === undefined) throw new TypeError("Missing supplied agent directory");
          return directory;
        };
      `,
      "utf8",
    );
    const suppliedTuiDirectory = join(directory, "node_modules", "@earendil-works", "pi-tui");
    await mkdir(suppliedTuiDirectory, { recursive: true });
    await writeFile(
      join(suppliedTuiDirectory, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-tui",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "utf8",
    );
    await writeFile(
      join(suppliedTuiDirectory, "index.js"),
      `
        export const Key = { home: "home", end: "end", space: "space" };
        export const matchesKey = () => false;
        export const truncateToWidth = (text) => text;
      `,
      "utf8",
    );
    const runnerPath = join(directory, "load installed extension 日本語.mjs");
    await writeFile(
      runnerPath,
      `
        import audioFeedbackExtension from "pi-audio-feedback";
        const registrations = [];
        const commands = [];
        audioFeedbackExtension({
          on: (event, handler) => registrations.push({ event, handler }),
          registerCommand: (name, command) => commands.push({ name, command }),
        });
        if (commands.length !== 1 || commands[0].name !== "audio:config") {
          throw new TypeError("Installed extension did not synchronously register /audio:config");
        }
        if (globalThis.__PI_PUBLIC_GET_AGENT_DIR_CALLS__ !== 1) {
          throw new TypeError("Installed extension did not use the supplied public Pi API");
        }
        const events = registrations.map(({ event }) => event);
        const expected = [
          "session_start", "agent_start", "tool_execution_end",
          "agent_end", "agent_settled", "session_shutdown",
        ];
        if (JSON.stringify(events) !== JSON.stringify(expected)) {
          throw new TypeError("Installed extension did not register lifecycle hooks");
        }
      `,
      "utf8",
    );
    const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    execFileSync(process.execPath, [tsxCli, runnerPath], {
      cwd: directory,
      env: { ...process.env, PI_TEST_AGENT_DIR: join(directory, "agent data 日本語") },
      stdio: "pipe",
    });
  });
});
