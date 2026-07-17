import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerAudioFeedbackExtension } from "../extensions/index.js";
import type { SchedulerChild } from "../extensions/scheduler.js";

const NETWORK_MODULE_PATTERN = /^(?:node:)?(?:http|https|http2|net|tls|dns|dgram)(?:\/|$)/;
const NETWORK_CALL_PATTERN = /\b(?:fetch|WebSocket|EventSource)\s*\(/;
const temporaryDirectories: string[] = [];

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

type Hook = (event: Readonly<Record<string, unknown>>, context: ExtensionContext) => unknown;
type Command = (args: string, context: ExtensionCommandContext) => unknown;

function moduleSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].flatMap((match) => {
    const value = match[1];
    return value === undefined ? [] : [value];
  });
}

function installOutputSpies(): {
  assertClean(): void;
  restore(): void;
} {
  const stdout = vi.spyOn(process.stdout, "write");
  const stderr = vi.spyOn(process.stderr, "write");
  const log = vi.spyOn(console, "log");
  const info = vi.spyOn(console, "info");
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  return {
    assertClean: () => {
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
      log.mockRestore();
      info.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    },
  };
}

function createRuntimeHarness(
  agentDirectory: string,
  moduleUrl = import.meta.url,
): {
  readonly hooks: Map<string, Hook>;
  readonly command: Command;
  readonly context: ExtensionContext;
  readonly children: FakeChild[];
  readonly activeTimers: Set<unknown>;
} {
  const hooks = new Map<string, Hook>();
  let command: Command | undefined;
  const children: FakeChild[] = [];
  const activeTimers = new Set<unknown>();
  let timerId = 0;
  const pi = {
    on: (name: string, hook: Hook) => hooks.set(name, hook),
    registerCommand: (_name: string, definition: { handler: Command }) => {
      command = definition.handler;
    },
  } as unknown as ExtensionAPI;
  const context = {
    mode: "tui",
    isIdle: () => true,
    ui: {
      onTerminalInput: () => () => undefined,
      notify: () => undefined,
      custom: async <T>(
        factory: (
          tui: { requestRender(): void },
          theme: { fg(_color: string, text: string): string; bold(text: string): string },
          keybindings: { matches(data: string, binding: string): boolean },
          done: (value: T) => void,
        ) => { handleInput?(data: string): void },
      ): Promise<T> =>
        new Promise<T>((resolve) => {
          const component = factory(
            { requestRender: () => undefined },
            { fg: (_color, text) => text, bold: (text) => text },
            {
              matches: (data, binding) =>
                (binding === "tui.select.down" && data === "down") ||
                (binding === "tui.select.confirm" && data === "enter") ||
                (binding === "tui.select.cancel" && data === "escape"),
            },
            resolve,
          );
          component.handleInput?.("escape");
        }),
    },
  } as unknown as ExtensionContext;

  registerAudioFeedbackExtension(pi, {
    agentDirectory,
    environment: {},
    platform: "darwin",
    operatingSystemRelease: "fixture",
    moduleUrl,
    launchPlayer: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    timers: {
      setTimeout: () => {
        const handle = timerId++;
        activeTimers.add(handle);
        return handle;
      },
      clearTimeout: (handle) => activeTimers.delete(handle),
    },
    clock: { now: () => 0 },
  });
  if (command === undefined) throw new Error("audio:config was not registered");
  return { hooks, command, context, children, activeTimers };
}

async function invoke(
  harness: ReturnType<typeof createRuntimeHarness>,
  name: string,
  event: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const hook = harness.hooks.get(name);
  if (hook === undefined) throw new Error(`Missing hook: ${name}`);
  return Promise.resolve(hook(event, harness.context));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("runtime privacy and output containment", () => {
  it("has a closed production import graph with no runtime network primitive", async () => {
    const extensionDirectory = new URL("../extensions/", import.meta.url);
    const files = (await readdir(extensionDirectory)).filter((path) => path.endsWith(".ts")).sort();
    expect(files).toEqual([
      "audio-catalog.ts",
      "config.ts",
      "eligibility.ts",
      "index.ts",
      "platform-adapters.ts",
      "scheduler.ts",
      "settings.ts",
      "terminal-outcomes.ts",
    ]);

    for (const file of files) {
      const source = await import("node:fs/promises").then(({ readFile }) =>
        readFile(new URL(file, extensionDirectory), "utf8"),
      );
      expect(source, `${file} must not call a network global`).not.toMatch(NETWORK_CALL_PATTERN);
      for (const specifier of moduleSpecifiers(source)) {
        expect(NETWORK_MODULE_PATTERN.test(specifier), `${file}: ${specifier}`).toBe(false);
        expect(specifier.startsWith("http://") || specifier.startsWith("https://")).toBe(false);
      }
    }
  });

  it("loads, runs lifecycle playback, opens Settings, and shuts down offline and silently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio privacy 日本語 "));
    temporaryDirectories.push(directory);
    const fetchSpy = vi.fn(() => Promise.reject(new Error("runtime network forbidden")));
    vi.stubGlobal("fetch", fetchSpy);
    const output = installOutputSpies();
    try {
      const harness = createRuntimeHarness(
        directory,
        new URL("../extensions/index.ts", import.meta.url).href,
      );
      await expect(
        invoke(harness, "session_start", { type: "session_start", reason: "startup" }),
      ).resolves.toBeUndefined();
      expect(harness.children).toHaveLength(1);
      harness.children[0]?.emit("spawn");
      harness.children[0]?.emit("close", 7, null);
      await flush();
      await expect(
        harness.command("", harness.context as unknown as ExtensionCommandContext),
      ).resolves.toBeUndefined();
      await expect(
        invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }),
      ).resolves.toBeUndefined();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(harness.activeTimers.size).toBe(0);
      output.assertClean();
    } finally {
      output.restore();
    }
  });

  it("contains malformed config, missing assets, and asynchronous spawn errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio expected failures "));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "pi-audio-feedback.json"), "{ malformed", "utf8");
    const output = installOutputSpies();
    try {
      const missingModuleUrl = new URL("extensions/index.ts", `file://${directory}/`).href;
      const missing = createRuntimeHarness(directory, missingModuleUrl);
      await expect(
        invoke(missing, "session_start", { type: "session_start", reason: "startup" }),
      ).resolves.toBeUndefined();
      expect(missing.children).toEqual([]);
      await expect(
        missing.command("", missing.context as unknown as ExtensionCommandContext),
      ).resolves.toBeUndefined();
      await invoke(missing, "session_shutdown", { type: "session_shutdown", reason: "quit" });

      const spawning = createRuntimeHarness(
        directory,
        new URL("../extensions/index.ts", import.meta.url).href,
      );
      await invoke(spawning, "session_start", { type: "session_start", reason: "startup" });
      const child = spawning.children[0];
      if (child === undefined) throw new Error("Expected injected player child");
      expect(() =>
        child.emit("error", Object.assign(new Error("missing player"), { code: "ENOENT" })),
      ).not.toThrow();
      await flush();
      await invoke(spawning, "session_shutdown", { type: "session_shutdown", reason: "quit" });

      output.assertClean();
    } finally {
      output.restore();
    }
  });
});
