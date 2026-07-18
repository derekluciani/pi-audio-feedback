import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DynamicBorder: class {
    readonly #color: (text: string) => string;

    constructor(color: (text: string) => string = (text) => text) {
      this.#color = color;
    }

    render(width: number): string[] {
      return [this.#color("─".repeat(Math.max(0, width)))];
    }

    invalidate(): void {}
  },
  getAgentDir: (): string => "/supplied/pi-agent",
}));

import type { AudioEvent, AudioTheme } from "../src/audio-catalog.js";
import type { LaunchableAudioCue } from "../src/eligibility.js";
import type { SchedulerChild } from "../src/scheduler.js";
import { THEME_SELECTOR_HELPER } from "../src/settings.js";

const { LITERAL_ESCAPE_SEQUENCE, registerAudioFeedbackExtension } = await import("../src/index.js");

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

type Hook = (event: unknown, context: ExtensionContext) => unknown;
type CommandHandler = (args: string, context: ExtensionCommandContext) => unknown;

interface TestComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
}

interface CustomInvocationOptions {
  readonly overlay?: boolean;
  readonly overlayOptions?: unknown;
  readonly onHandle?: (handle: { focus(): void }) => void;
}

interface ExtensionHarness {
  readonly hooks: Map<string, Hook>;
  readonly commands: Map<string, CommandHandler>;
  readonly customComponents: TestComponent[];
  readonly customOptions: Array<CustomInvocationOptions | undefined>;
  readonly notifications: Array<{ message: string; type: string | undefined }>;
  setIdle(value: boolean): void;
  readonly starts: Array<{ event: AudioEvent; theme: AudioTheme }>;
  readonly children: FakeChild[];
  readonly terminalListeners: Array<(data: string) => unknown>;
  readonly removeTerminalListener: ReturnType<typeof vi.fn>;
  readonly activeTimers: Map<number, () => void>;
  readonly context: ExtensionContext;
}

function createHarness(agentDirectory: string, mode: "tui" | "rpc" = "tui"): ExtensionHarness {
  const hooks = new Map<string, Hook>();
  const commands = new Map<string, CommandHandler>();
  const customComponents: TestComponent[] = [];
  const customOptions: Array<CustomInvocationOptions | undefined> = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let idle = true;
  const starts: Array<{ event: AudioEvent; theme: AudioTheme }> = [];
  const children: FakeChild[] = [];
  const terminalListeners: Array<(data: string) => unknown> = [];
  const removeTerminalListener = vi.fn();
  const activeTimers = new Map<number, () => void>();
  let nextTimer = 0;

  const on = vi.fn((name: string, hook: Hook) => hooks.set(name, hook));
  const registerCommand = vi.fn((name: string, command: { handler: CommandHandler }) =>
    commands.set(name, command.handler),
  );
  const pi = { on, registerCommand } as unknown as ExtensionAPI;
  const ui = {
    onTerminalInput: vi.fn((listener: (data: string) => unknown) => {
      terminalListeners.push(listener);
      return removeTerminalListener;
    }),
    notify: vi.fn((message: string, type?: string) => notifications.push({ message, type })),
    custom: vi.fn(
      <T>(
        factory: (
          tui: { requestRender(): void },
          theme: {
            fg(_color: string, text: string): string;
            bold(text: string): string;
          },
          keybindings: { matches(data: string, binding: string): boolean },
          done: (value: T) => void,
        ) => TestComponent,
        options?: CustomInvocationOptions,
      ): Promise<T> =>
        new Promise<T>((resolve) => {
          customOptions.push(options);
          const component = factory(
            { requestRender: vi.fn() },
            { fg: (_color, text) => text, bold: (text) => text },
            {
              matches: (data, binding) => {
                const controls: Record<string, string[]> = {
                  "tui.select.up": ["up"],
                  "tui.select.down": ["down"],
                  "tui.select.pageUp": ["pageUp"],
                  "tui.select.pageDown": ["pageDown"],
                  "tui.select.confirm": ["enter"],
                  "tui.select.cancel": ["escape", "ctrl+c"],
                };
                return controls[binding]?.includes(data) ?? false;
              },
            },
            resolve,
          );
          customComponents.push(component);
        }),
    ),
  };
  const context = {
    mode,
    ui,
    isIdle: () => idle,
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
    commands,
    customComponents,
    customOptions,
    notifications,
    setIdle: (value) => {
      idle = value;
    },
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

function invokeCommand(harness: ExtensionHarness): Promise<unknown> {
  const command = harness.commands.get("audio:config");
  if (command === undefined) throw new Error("Missing audio:config command");
  return Promise.resolve(command("", harness.context as unknown as ExtensionCommandContext));
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

  it("registers /audio:config synchronously and gates non-TUI and active sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-command-gate-"));
    const rpcHarness = createHarness(directory, "rpc");
    expect([...rpcHarness.commands.keys()]).toEqual(["audio:config"]);
    await invokeCommand(rpcHarness);
    expect(rpcHarness.customComponents).toEqual([]);
    expect(rpcHarness.notifications).toEqual([]);

    const tuiHarness = createHarness(directory);
    await invokeCommand(tuiHarness); // before session_start
    expect(tuiHarness.customComponents).toEqual([]);
    await invoke(tuiHarness, "session_start", { type: "session_start", reason: "new" });
    tuiHarness.setIdle(false);
    await invokeCommand(tuiHarness);
    expect(tuiHarness.notifications).toEqual([
      { message: "Audio settings are available when Pi is idle.", type: "info" },
    ]);
    expect(tuiHarness.customComponents).toEqual([]);
    expect(tuiHarness.starts).toEqual([]);
  });

  it("opens one inline component, ignores reinvocation, and closes one level at a time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-command-singleton-"));
    const harness = createHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "new" });

    const firstCommand = invokeCommand(harness);
    await invokeCommand(harness); // reinvoked while disk reload is still opening
    await vi.waitFor(() => {
      expect(harness.customComponents).toHaveLength(1);
    });
    expect(harness.starts.map(({ event }) => event)).toEqual(["settingsRootEnter"]);
    const rootLines = harness.customComponents[0]?.render(80);
    expect(rootLines?.some((line) => line.includes("Turn all sounds on"))).toBe(true);
    expect(rootLines?.at(0)).toBe("─".repeat(80));
    expect(rootLines?.at(-1)).toBe("─".repeat(80));
    await invokeCommand(harness);
    expect(harness.customComponents).toHaveLength(1);
    expect(harness.customOptions).toEqual([undefined]);

    const component = harness.customComponents[0];
    if (component?.handleInput === undefined) throw new Error("Expected interactive component");
    component.handleInput("down");
    component.handleInput("down");
    component.handleInput("down");
    component.handleInput("enter");
    await flush();
    await vi.waitFor(() => {
      expect(component.render(80)).toContain(THEME_SELECTOR_HELPER);
    });
    component.handleInput("escape");
    await flush();
    expect(component.render(80).some((line) => line.includes("Turn all sounds on"))).toBe(true);
    component.handleInput("ctrl+c");
    await firstCommand;

    const reopenedCommand = invokeCommand(harness);
    await vi.waitFor(() => {
      expect(harness.customComponents).toHaveLength(2);
    });
    expect(harness.customOptions).toEqual([undefined, undefined]);
    harness.customComponents[1]?.handleInput?.("escape");
    await reopenedCommand;
  });

  it("reloads configuration on open and emits only one Settings warning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio-extension-command-warning-"));
    const harness = createHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "new" });
    await writeFile(join(directory, "pi-audio-feedback.json"), "{ malformed");

    const command = invokeCommand(harness);
    await vi.waitFor(() => {
      expect(harness.customComponents).toHaveLength(1);
    });
    expect(harness.notifications).toEqual([
      {
        message: "Audio settings found malformed configuration; using defaults.",
        type: "warning",
      },
    ]);
    await invokeCommand(harness);
    expect(harness.notifications).toHaveLength(1);
    harness.customComponents[0]?.handleInput?.("escape");
    await command;
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
