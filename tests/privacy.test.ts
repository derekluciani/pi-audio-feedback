import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import * as nodeFileSystem from "node:fs/promises";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

const hostMocks = vi.hoisted(() => {
  const networkCalls: string[] = [];
  const forbidden = (name: string) =>
    vi.fn(() => {
      networkCalls.push(name);
      throw new Error(`Runtime network forbidden: ${name}`);
    });
  return { networkCalls, forbidden };
});

// These public host-boundary mocks are installed before the production extension is imported. This
// keeps Node 20 from eagerly loading Pi's unrelated undici path while preserving the Pi/TUI APIs the
// extension actually consumes. The separate package/minimum-Pi acceptance test loads real 0.80.6.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: (): string => "/host-provided-agent-directory",
}));
vi.mock("@earendil-works/pi-tui", () => ({
  Key: { home: "home", end: "end", space: " " },
  matchesKey: (data: string, key: string): boolean => data === key,
  truncateToWidth: (text: string, width: number): string => text.slice(0, width),
}));
vi.mock("node:http", () => ({
  request: hostMocks.forbidden("http.request"),
  get: hostMocks.forbidden("http.get"),
  createServer: hostMocks.forbidden("http.createServer"),
}));
vi.mock("node:https", () => ({
  request: hostMocks.forbidden("https.request"),
  get: hostMocks.forbidden("https.get"),
  createServer: hostMocks.forbidden("https.createServer"),
}));
vi.mock("node:net", () => ({
  connect: hostMocks.forbidden("net.connect"),
  createConnection: hostMocks.forbidden("net.createConnection"),
  createServer: hostMocks.forbidden("net.createServer"),
  Socket: hostMocks.forbidden("new net.Socket"),
}));
vi.mock("node:dns", () => ({
  lookup: hostMocks.forbidden("dns.lookup"),
  resolve: hostMocks.forbidden("dns.resolve"),
  Resolver: hostMocks.forbidden("new dns.Resolver"),
  promises: {
    lookup: hostMocks.forbidden("dns.promises.lookup"),
    resolve: hostMocks.forbidden("dns.promises.resolve"),
  },
}));

const { LITERAL_ESCAPE_SEQUENCE, registerAudioFeedbackExtension } =
  await import("../extensions/index.js");
import type {
  AudioFeedbackResourceSnapshot,
  ConfigurationFileSystem,
  LaunchableAudioCue,
  SchedulerChild,
} from "../extensions/index.js";

const NETWORK_MODULES = new Set([
  "http",
  "node:http",
  "https",
  "node:https",
  "http2",
  "node:http2",
  "net",
  "node:net",
  "tls",
  "node:tls",
  "dns",
  "node:dns",
  "dns/promises",
  "node:dns/promises",
  "dgram",
  "node:dgram",
]);
const temporaryDirectories: string[] = [];

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

type Hook = (event: Readonly<Record<string, unknown>>, context: ExtensionContext) => unknown;
type Command = (args: string, context: ExtensionCommandContext) => unknown;
type TestComponent = { handleInput?(data: string): void };

interface RuntimeHarness {
  readonly hooks: Map<string, Hook>;
  readonly command: Command;
  readonly context: ExtensionContext;
  readonly children: FakeChild[];
  readonly starts: string[];
  readonly activeTimers: Set<number>;
  readonly terminalListeners: Set<(data: string) => unknown>;
  readonly removeTerminalListener: ReturnType<typeof vi.fn>;
  readonly components: TestComponent[];
  readonly notifications: string[];
  activeComponentCount(): number;
  schedulerResources(): AudioFeedbackResourceSnapshot;
}

function callName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = callName(expression.expression);
    return parent === null ? expression.name.text : `${parent}.${expression.name.text}`;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    const parent = callName(expression.expression);
    return parent === null
      ? expression.argumentExpression.text
      : `${parent}.${expression.argumentExpression.text}`;
  }
  return null;
}

function assertSafeModuleSpecifier(file: string, node: ts.Node, value: ts.Expression): void {
  expect(
    ts.isStringLiteralLike(value),
    `${file}:${String(node.getStart())} dynamic module specifier`,
  ).toBe(true);
  if (!ts.isStringLiteralLike(value)) return;
  const specifier = value.text;
  const networkModule = [...NETWORK_MODULES].some(
    (candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`),
  );
  expect(networkModule, `${file}: forbidden ${specifier}`).toBe(false);
  expect(/^https?:\/\//u.test(specifier), `${file}: URL module ${specifier}`).toBe(false);
}

function assertNoNetworkEscape(file: string, source: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      assertSafeModuleSpecifier(file, node, node.moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      throw new Error(`${file}:${String(node.getStart())} import-equals can bypass the ESM graph`);
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        expect(node.arguments).toHaveLength(1);
        const argument = node.arguments[0];
        if (argument !== undefined) assertSafeModuleSpecifier(file, node, argument);
      }
      const name = callName(node.expression);
      const forbiddenCall =
        name === "fetch" ||
        name === "globalThis.fetch" ||
        name === "eval" ||
        name === "Function" ||
        name === "require" ||
        name === "createRequire" ||
        name?.endsWith(".createRequire") === true ||
        name === "process.binding" ||
        name === "process._linkedBinding" ||
        name === "process.getBuiltinModule" ||
        name === "module.constructor._load";
      expect(
        forbiddenCall,
        `${file}:${String(node.getStart())} forbidden call ${name ?? "<computed>"}`,
      ).toBe(false);
    }
    if (ts.isNewExpression(node)) {
      const name = callName(node.expression);
      const forbiddenConstructor =
        name === "Function" ||
        name === "WebSocket" ||
        name === "EventSource" ||
        name === "globalThis.WebSocket" ||
        name === "globalThis.EventSource";
      expect(
        forbiddenConstructor,
        `${file}:${String(node.getStart())} forbidden constructor ${name ?? "<computed>"}`,
      ).toBe(false);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = callName(node);
      expect(
        name === "process.mainModule" ||
          name === "globalThis.fetch" ||
          name === "globalThis.eval" ||
          name === "globalThis.Function" ||
          name === "globalThis.WebSocket" ||
          name === "globalThis.EventSource",
        `${file}:${String(node.getStart())} forbidden binding ${name ?? "<computed>"}`,
      ).toBe(false);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function installContainmentSentinels(): {
  assertClean(): void;
  restore(): void;
} {
  const spies = [
    vi.spyOn(process.stdout, "write"),
    vi.spyOn(process.stderr, "write"),
    vi.spyOn(console, "log"),
    vi.spyOn(console, "info"),
    vi.spyOn(console, "warn"),
    vi.spyOn(console, "error"),
    vi.spyOn(console, "debug"),
    vi.spyOn(console, "trace"),
  ];
  const rejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  return {
    assertClean: () => {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(rejections).toEqual([]);
      expect(hostMocks.networkCalls).toEqual([]);
    },
    restore: () => {
      process.removeListener("unhandledRejection", onUnhandledRejection);
      for (const spy of spies) spy.mockRestore();
    },
  };
}

function createRuntimeHarness(
  agentDirectory: string,
  options: {
    readonly moduleUrl?: string;
    readonly launchPlayer?: (cue: LaunchableAudioCue) => SchedulerChild;
    readonly configurationFileSystem?: ConfigurationFileSystem;
  } = {},
): RuntimeHarness {
  const hooks = new Map<string, Hook>();
  let command: Command | undefined;
  const children: FakeChild[] = [];
  const starts: string[] = [];
  const activeTimers = new Set<number>();
  const terminalListeners = new Set<(data: string) => unknown>();
  const components: TestComponent[] = [];
  const notifications: string[] = [];
  let activeComponents = 0;
  let timerId = 0;
  let inspectScheduler: (() => AudioFeedbackResourceSnapshot) | undefined;
  const removeTerminalListener = vi.fn();
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
      onTerminalInput: (listener: (data: string) => unknown) => {
        terminalListeners.add(listener);
        return () => {
          terminalListeners.delete(listener);
          removeTerminalListener();
        };
      },
      notify: (message: string) => notifications.push(message),
      custom: <T>(
        factory: (
          tui: { requestRender(): void },
          theme: { fg(_color: string, text: string): string; bold(text: string): string },
          keybindings: { matches(data: string, binding: string): boolean },
          done: (value: T) => void,
        ) => TestComponent,
      ): Promise<T> =>
        new Promise<T>((resolve) => {
          activeComponents += 1;
          let finished = false;
          const component = factory(
            { requestRender: () => undefined },
            { fg: (_color, text) => text, bold: (text) => text },
            {
              matches: (data, binding) =>
                (binding === "tui.select.down" && data === "down") ||
                (binding === "tui.select.confirm" && data === "enter") ||
                (binding === "tui.select.cancel" && data === "escape"),
            },
            (value) => {
              if (!finished) {
                finished = true;
                activeComponents -= 1;
              }
              resolve(value);
            },
          );
          components.push(component);
        }),
    },
  } as unknown as ExtensionContext;

  registerAudioFeedbackExtension(pi, {
    agentDirectory,
    environment: {},
    platform: "darwin",
    operatingSystemRelease: "fixture",
    moduleUrl: options.moduleUrl ?? new URL("../extensions/index.ts", import.meta.url).href,
    launchPlayer: (cue) => {
      starts.push(cue.event);
      const child = options.launchPlayer?.(cue) ?? new FakeChild();
      if (child instanceof FakeChild) children.push(child);
      return child;
    },
    ...(options.configurationFileSystem === undefined
      ? {}
      : { configurationFileSystem: options.configurationFileSystem }),
    timers: {
      setTimeout: () => {
        const handle = timerId++;
        activeTimers.add(handle);
        return handle;
      },
      clearTimeout: (handle) => activeTimers.delete(Number(handle)),
    },
    clock: { now: () => 0 },
    onSchedulerCreated: (inspect) => {
      inspectScheduler = inspect;
    },
  });
  if (command === undefined) throw new Error("audio:config was not registered");
  return {
    hooks,
    command,
    context,
    children,
    starts,
    activeTimers,
    terminalListeners,
    removeTerminalListener,
    components,
    notifications,
    activeComponentCount: () => activeComponents,
    schedulerResources: () => {
      if (inspectScheduler === undefined) throw new Error("Session scheduler was not created");
      return inspectScheduler();
    },
  };
}

async function invoke(
  harness: RuntimeHarness,
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
  await Promise.resolve();
}

function assertPlayerResourcesClean(harness: RuntimeHarness): void {
  expect(harness.schedulerResources()).toMatchObject({
    trackedChildCount: 0,
    pendingEvent: null,
    hasActiveWatchdog: false,
  });
  expect(harness.activeTimers.size).toBe(0);
  for (const child of harness.children) {
    expect(child.eventNames()).toEqual([]);
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  }
}

async function shutdownAndAssertClean(harness: RuntimeHarness): Promise<void> {
  await expect(
    invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }),
  ).resolves.toBeUndefined();
  assertPlayerResourcesClean(harness);
  expect(harness.terminalListeners.size).toBe(0);
  expect(harness.removeTerminalListener).toHaveBeenCalledOnce();
  expect(harness.activeComponentCount()).toBe(0);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  hostMocks.networkCalls.splice(0);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("runtime privacy and output containment", () => {
  it("uses a TypeScript AST to prove the closed runtime graph has no network or loader escape", async () => {
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
      const sourceText = await nodeFileSystem.readFile(new URL(file, extensionDirectory), "utf8");
      const source = ts.createSourceFile(
        file,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      assertNoNetworkEscape(file, source);
    }
  });

  it.each([
    { name: "successful close(0)", outcome: "success" },
    { name: "silent nonzero close", outcome: "nonzero" },
    { name: "contained synchronous spawn throw", outcome: "throw" },
    { name: "contained asynchronous pre-spawn error", outcome: "error" },
  ] as const)(
    "runs $name through the session hook with zero output or leaks",
    async ({ outcome }) => {
      const directory = await mkdtemp(join(tmpdir(), "audio boundary 日本語 "));
      temporaryDirectories.push(directory);
      const fetchSpy = vi.fn(() => Promise.reject(new Error("runtime network forbidden")));
      vi.stubGlobal("fetch", fetchSpy);
      const output = installContainmentSentinels();
      try {
        const harness = createRuntimeHarness(directory, {
          launchPlayer: () => {
            if (outcome === "throw") throw new Error("synchronous spawn failure");
            return new FakeChild();
          },
        });
        await expect(
          invoke(harness, "session_start", { type: "session_start", reason: "startup" }),
        ).resolves.toBeUndefined();
        if (outcome === "success" || outcome === "nonzero") {
          const child = harness.children[0];
          if (child === undefined) throw new Error("Expected player child");
          child.emit("spawn");
          child.emit("close", outcome === "success" ? 0 : 7, null);
        } else if (outcome === "error") {
          const child = harness.children[0];
          if (child === undefined) throw new Error("Expected player child");
          child.emit("error", Object.assign(new Error("missing player"), { code: "ENOENT" }));
        }
        await flush();
        assertPlayerResourcesClean(harness);
        await shutdownAndAssertClean(harness);
        expect(fetchSpy).not.toHaveBeenCalled();
        output.assertClean();
      } finally {
        output.restore();
      }
    },
  );

  it("contains missing assets and malformed real configuration through session and Settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio malformed and missing "));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "pi-audio-feedback.json"), "{ malformed", "utf8");
    const output = installContainmentSentinels();
    try {
      const missingModuleUrl = new URL("extensions/index.ts", `file://${directory}/`).href;
      const harness = createRuntimeHarness(directory, { moduleUrl: missingModuleUrl });
      await expect(
        invoke(harness, "session_start", { type: "session_start", reason: "startup" }),
      ).resolves.toBeUndefined();
      expect(harness.children).toEqual([]);
      const command = Promise.resolve(
        harness.command("", harness.context as unknown as ExtensionCommandContext),
      );
      await vi.waitFor(() => {
        expect(harness.components).toHaveLength(1);
      });
      expect(harness.notifications).toEqual([
        "Audio settings found malformed configuration; using defaults.",
      ]);
      harness.components[0]?.handleInput?.("escape");
      await command;
      expect(harness.activeComponentCount()).toBe(0);
      expect(harness.terminalListeners.size).toBe(1);
      expect(harness.removeTerminalListener).not.toHaveBeenCalled();
      assertPlayerResourcesClean(harness);
      await shutdownAndAssertClean(harness);
      output.assertClean();
    } finally {
      output.restore();
    }
  });

  it("contains an actual ConfigurationStore rename failure reached from Settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio settings rename failure "));
    temporaryDirectories.push(directory);
    const failingFileSystem: ConfigurationFileSystem = {
      lstat: (path) => nodeFileSystem.lstat(path),
      mkdir: (path, options) => nodeFileSystem.mkdir(path, options),
      open: (path, flags, mode) => nodeFileSystem.open(path, flags, mode),
      rename: () =>
        Promise.reject(
          Object.assign(new Error("injected real-store rename failure"), { code: "EACCES" }),
        ),
      unlink: (path) => nodeFileSystem.unlink(path),
    };
    const output = installContainmentSentinels();
    try {
      const harness = createRuntimeHarness(directory, {
        configurationFileSystem: failingFileSystem,
      });
      await invoke(harness, "session_start", { type: "session_start", reason: "new" });
      const command = Promise.resolve(
        harness.command("", harness.context as unknown as ExtensionCommandContext),
      );
      await vi.waitFor(() => {
        expect(harness.components).toHaveLength(1);
      });
      const rootEnter = harness.children[0];
      if (rootEnter === undefined) throw new Error("Expected Settings root-enter child");
      rootEnter.emit("spawn");
      rootEnter.emit("close", 0, null);
      await flush();

      const component = harness.components[0];
      component?.handleInput?.("down");
      await vi.waitFor(() => {
        expect(harness.children).toHaveLength(2);
      });
      const navigation = harness.children[1];
      navigation?.emit("error", Object.assign(new Error("player unavailable"), { code: "ENOENT" }));
      await flush();
      component?.handleInput?.("enter");
      await vi.waitFor(() => {
        expect(harness.notifications).toContain(
          "Audio settings could not be saved; the previous value was restored.",
        );
      });
      const toggleOff = harness.children.at(-1);
      toggleOff?.emit("spawn");
      toggleOff?.emit("close", 0, null);
      await flush();
      component?.handleInput?.("escape");
      await command;
      for (const child of harness.children) {
        if (child.listenerCount("close") > 0) {
          child.emit("close", 0, null);
        }
      }
      await flush();

      await expect(
        nodeFileSystem.readFile(join(directory, "pi-audio-feedback.json")),
      ).rejects.toThrow();
      expect(harness.activeComponentCount()).toBe(0);
      expect(harness.terminalListeners.size).toBe(1);
      expect(harness.removeTerminalListener).not.toHaveBeenCalled();
      assertPlayerResourcesClean(harness);
      await shutdownAndAssertClean(harness);
      output.assertClean();
    } finally {
      output.restore();
    }
  });

  it("opens Settings while idle and treats raw literal Escape as additive, never an abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio settings raw escape "));
    temporaryDirectories.push(directory);
    const output = installContainmentSentinels();
    try {
      const harness = createRuntimeHarness(directory);
      await invoke(harness, "session_start", { type: "session_start", reason: "new" });
      const command = Promise.resolve(
        harness.command("", harness.context as unknown as ExtensionCommandContext),
      );
      await vi.waitFor(() => {
        expect(harness.components).toHaveLength(1);
      });
      expect(harness.activeComponentCount()).toBe(1);
      const rawListener = [...harness.terminalListeners][0];
      if (rawListener === undefined) throw new Error("Expected public raw terminal listener");
      expect(rawListener(LITERAL_ESCAPE_SEQUENCE)).toBeUndefined();
      expect(harness.activeComponentCount()).toBe(1);
      harness.components[0]?.handleInput?.("escape");
      await command;
      await invoke(harness, "agent_settled", { type: "agent_settled" });
      expect(harness.starts).not.toContain("agentAborted");
      for (const child of harness.children) {
        child.emit("error", Object.assign(new Error("player unavailable"), { code: "ENOENT" }));
      }
      await flush();
      expect(harness.activeComponentCount()).toBe(0);
      expect(harness.terminalListeners.size).toBe(1);
      expect(harness.removeTerminalListener).not.toHaveBeenCalled();
      assertPlayerResourcesClean(harness);
      await shutdownAndAssertClean(harness);
      output.assertClean();
    } finally {
      output.restore();
    }
  });
});
