import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: (): string => "/supplied/pi-agent",
}));

import type { AudioEvent, AudioTheme } from "../extensions/audio-catalog.js";
import type { LaunchableAudioCue } from "../extensions/eligibility.js";
import type { SchedulerChild } from "../extensions/scheduler.js";

const { LITERAL_ESCAPE_SEQUENCE, registerAudioFeedbackExtension } =
  await import("../extensions/index.js");

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

type Hook = (event: unknown, context: ExtensionContext) => unknown;

interface ExtensionHarness {
  readonly hooks: Map<string, Hook>;
  readonly starts: Array<{ event: AudioEvent; theme: AudioTheme }>;
  readonly children: FakeChild[];
  readonly terminalListeners: Array<(data: string) => unknown>;
  readonly removeTerminalListener: ReturnType<typeof vi.fn>;
  readonly activeTimers: Map<number, () => void>;
  readonly context: ExtensionContext;
}

function createHarness(agentDirectory: string, mode: "tui" | "rpc" = "tui"): ExtensionHarness {
  const hooks = new Map<string, Hook>();
  const starts: Array<{ event: AudioEvent; theme: AudioTheme }> = [];
  const children: FakeChild[] = [];
  const terminalListeners: Array<(data: string) => unknown> = [];
  const removeTerminalListener = vi.fn();
  const activeTimers = new Map<number, () => void>();
  let nextTimer = 0;

  const on = vi.fn((name: string, hook: Hook) => hooks.set(name, hook));
  const pi = { on } as unknown as ExtensionAPI;
  const ui = {
    onTerminalInput: vi.fn((listener: (data: string) => unknown) => {
      terminalListeners.push(listener);
      return removeTerminalListener;
    }),
  };
  const context = {
    mode,
    ui,
    isIdle: () => true,
  } as unknown as ExtensionContext;

  registerAudioFeedbackExtension(pi, {
    agentDirectory,
    environment: {},
    platform: "darwin",
    operatingSystemRelease: "test",
    launchPlayer: (cue: LaunchableAudioCue) => {
      starts.push({ event: cue.event, theme: cue.theme });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    timers: {
      setTimeout: (callback) => {
        const id = nextTimer++;
        activeTimers.set(id, callback);
        return id;
      },
      clearTimeout: (handle) => activeTimers.delete(Number(handle)),
    },
    clock: { now: () => 0 },
  });

  return {
    hooks,
    starts,
    children,
    terminalListeners,
    removeTerminalListener,
    activeTimers,
    context,
  };
}

function getHook(harness: ExtensionHarness, name: string): Hook {
  const hook = harness.hooks.get(name);
  if (hook === undefined) throw new Error(`Missing ${name} hook`);
  return hook;
}

function invoke(
  harness: ExtensionHarness,
  name: string,
  event: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  return Promise.resolve(getHook(harness, name)(event, harness.context));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForStarts(harness: ExtensionHarness, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(harness.starts).toHaveLength(count);
  });
}

function currentChild(harness: ExtensionHarness): FakeChild {
  const child = harness.children.at(-1);
  if (child === undefined) throw new Error("Expected a player child");
  return child;
}

async function spawnAndClose(child: FakeChild): Promise<void> {
  child.emit("spawn");
  child.emit("close", 0, null);
  await flush();
}

describe("Pi lifecycle integration", () => {
  it("registers the minimum public hook surface and runs exact normal lifecycle sequence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-"));
    const harness = createHarness(directory);

    expect([...harness.hooks.keys()]).toEqual([
      "session_start",
      "agent_start",
      "tool_execution_end",
      "agent_end",
      "agent_settled",
      "session_shutdown",
    ]);

    await invoke(harness, "session_start", { type: "session_start", reason: "startup" });
    expect(harness.starts.map(({ event }) => event)).toEqual(["appStart"]);
    expect(harness.terminalListeners).toHaveLength(1);
    expect(harness.terminalListeners[0]?.("x")).toBeUndefined();

    await spawnAndClose(currentChild(harness));
    expect(await invoke(harness, "agent_start", { type: "agent_start" })).toBeUndefined();
    await waitForStarts(harness, 2);
    expect(harness.starts.map(({ event }) => event)).toEqual(["appStart", "agentStart"]);
    await spawnAndClose(currentChild(harness));

    await invoke(harness, "agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
    });
    await invoke(harness, "agent_settled", { type: "agent_settled" });
    await waitForStarts(harness, 3);
    expect(harness.starts.map(({ event }) => event)).toEqual([
      "appStart",
      "agentStart",
      "agentSettled",
    ]);
  });

  it("reloads disk config for every context and requests appStart only for startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-reload-"));
    const harness = createHarness(directory);

    await invoke(harness, "session_start", { type: "session_start", reason: "new" });
    expect(harness.starts).toEqual([]);
    await invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "new" });

    await writeFile(
      join(directory, "pi-audio-feedback.json"),
      `${JSON.stringify({ version: 1, theme: "soft", events: { agentStart: true } })}\n`,
    );
    await invoke(harness, "session_start", { type: "session_start", reason: "resume" });
    await invoke(harness, "agent_start", { type: "agent_start" });
    await waitForStarts(harness, 1);
    expect(harness.starts).toEqual([{ event: "agentStart", theme: "soft" }]);

    await spawnAndClose(currentChild(harness));
    await invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "resume" });
    await invoke(harness, "session_start", { type: "session_start", reason: "fork" });
    await invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "fork" });
    await invoke(harness, "session_start", { type: "session_start", reason: "reload" });
    expect(harness.starts.map(({ event }) => event)).toEqual(["agentStart"]);
  });

  it("observes tool errors promptly without mutation and emits every low-level start", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-tool-"));
    const harness = createHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "new" });

    let expectedStarts = 0;
    for (const boundary of ["retry", "auto-compaction", "steering", "follow-up"]) {
      expect(boundary).toBeTruthy();
      expect(await invoke(harness, "agent_start", { type: "agent_start" })).toBeUndefined();
      expectedStarts += 1;
      await waitForStarts(harness, expectedStarts);
      await spawnAndClose(currentChild(harness));
    }
    expect(harness.starts.map(({ event }) => event)).toEqual([
      "agentStart",
      "agentStart",
      "agentStart",
      "agentStart",
    ]);

    const successfulTool = { type: "tool_execution_end", isError: false, result: { value: 1 } };
    await invoke(harness, "tool_execution_end", successfulTool);
    expect(successfulTool).toEqual({
      type: "tool_execution_end",
      isError: false,
      result: { value: 1 },
    });
    expect(harness.starts.map(({ event }) => event)).not.toContain("toolError");

    const failedTool = { type: "tool_execution_end", isError: true, result: { value: 2 } };
    expect(await invoke(harness, "tool_execution_end", failedTool)).toBeUndefined();
    await waitForStarts(harness, 5);
    expect(failedTool.result).toEqual({ value: 2 });
    expect(harness.starts.at(-1)?.event).toBe("toolError");
  });

  it("requires same-generation literal Escape plus exact final aborted assistant outcome", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-abort-"));
    const harness = createHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "new" });
    const listener = harness.terminalListeners[0];
    if (listener === undefined) throw new Error("Expected terminal listener");

    listener(LITERAL_ESCAPE_SEQUENCE); // idle
    await invoke(harness, "agent_start", { type: "agent_start" });
    await waitForStarts(harness, 1);
    await spawnAndClose(currentChild(harness));
    listener("escape"); // keybinding name/programmatic input is not literal terminal Escape
    await invoke(harness, "agent_end", {
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    await invoke(harness, "agent_settled", { type: "agent_settled" });
    await waitForStarts(harness, 2);
    expect(harness.starts.map(({ event }) => event)).toEqual(["agentStart", "agentSettled"]);
    await spawnAndClose(currentChild(harness));

    await invoke(harness, "agent_start", { type: "agent_start" });
    await waitForStarts(harness, 3);
    await spawnAndClose(currentChild(harness));
    listener(LITERAL_ESCAPE_SEQUENCE);
    await invoke(harness, "agent_end", {
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "stop" },
        { role: "assistant", stopReason: "aborted" },
      ],
    });
    await invoke(harness, "agent_settled", { type: "agent_settled" });
    await waitForStarts(harness, 4);
    expect(harness.starts.map(({ event }) => event)).toEqual([
      "agentStart",
      "agentSettled",
      "agentStart",
      "agentAborted",
    ]);
    expect(
      harness.starts.map(({ event }) => event).filter((event) => event === "agentSettled"),
    ).toHaveLength(1);
  });

  it("installs raw input only in TUI and idempotently cleans listeners, timers, and children", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-cleanup-"));
    await mkdir(directory, { recursive: true });
    const harness = createHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "startup" });
    const child = currentChild(harness);
    child.emit("spawn");
    expect(harness.activeTimers.size).toBe(1);

    await invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
    await invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(harness.removeTerminalListener).toHaveBeenCalledOnce();
    expect(harness.activeTimers.size).toBe(0);
    expect(child.kill).toHaveBeenCalledOnce();

    const rpcHarness = createHarness(directory, "rpc");
    await invoke(rpcHarness, "session_start", { type: "session_start", reason: "startup" });
    expect(rpcHarness.terminalListeners).toEqual([]);
  });

  it("contains malformed-config, listener, and launch failures without output or rejection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-failure-"));
    await writeFile(join(directory, "pi-audio-feedback.json"), "{ malformed");
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const harness = createHarness(directory);
    const ui = harness.context.ui as unknown as { onTerminalInput: ReturnType<typeof vi.fn> };
    ui.onTerminalInput.mockImplementation(() => {
      throw new Error("terminal unavailable");
    });

    await expect(
      invoke(harness, "session_start", { type: "session_start", reason: "startup" }),
    ).resolves.toBeUndefined();
    await invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
    stdout.mockRestore();
    stderr.mockRestore();
  });
});
