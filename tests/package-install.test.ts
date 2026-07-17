import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

type PackFile = { path: string };
type PackResult = { filename: string; files: PackFile[] };

const temporaryDirectories: string[] = [];

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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("published package", () => {
  it("contains only runtime material and installs without development dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-audio-feedback-"));
    temporaryDirectories.push(directory);

    const output = execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
      encoding: "utf8",
    });
    const packed = parsePackResult(output);
    const paths = packed.files.map((file) => file.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "LICENSE",
        "README.md",
        "THIRD_PARTY_NOTICES.md",
        "extensions/index.ts",
        "package.json",
        "scripts/play-wav.ps1",
      ]),
    );
    const wavManifestSource = await readFile(
      new URL("../assets/wav/manifest.json", import.meta.url),
      "utf8",
    );
    const wavManifest: unknown = JSON.parse(wavManifestSource);
    if (
      typeof wavManifest !== "object" ||
      wavManifest === null ||
      !("files" in wavManifest) ||
      typeof wavManifest.files !== "object" ||
      wavManifest.files === null
    ) {
      throw new TypeError("WAV manifest must contain a files object");
    }
    expect(paths).toEqual(
      expect.arrayContaining(["assets/wav/manifest.json", ...Object.keys(wavManifest.files)]),
    );

    expect(paths.some((path) => path.startsWith(".web-kits/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("assets/patches/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("tests/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("scripts/assets/"))).toBe(false);

    execFileSync("npm", ["init", "--yes"], { cwd: directory, stdio: "ignore" });
    execFileSync(
      "npm",
      [
        "install",
        "--omit=dev",
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

    // Pi 0.80.6 itself requires Node 22, so its full loader cannot execute on Node 20.
    // This root-only package mirrors Pi's public peer-module boundary and rejects private subpaths.
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
    const runnerPath = join(directory, "load-installed-extension.mjs");
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
      env: { ...process.env, PI_TEST_AGENT_DIR: join(directory, "agent") },
      stdio: "pipe",
    });
  });
});
