import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { EventEmitter } from "node:events";
import * as nodeFileSystem from "node:fs/promises";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("node:http2", () => ({
  connect: hostMocks.forbidden("http2.connect"),
  createServer: hostMocks.forbidden("http2.createServer"),
  createSecureServer: hostMocks.forbidden("http2.createSecureServer"),
}));
vi.mock("node:tls", () => ({
  connect: hostMocks.forbidden("tls.connect"),
  createServer: hostMocks.forbidden("tls.createServer"),
  TLSSocket: hostMocks.forbidden("new tls.TLSSocket"),
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
vi.mock("node:dns/promises", () => ({
  lookup: hostMocks.forbidden("dns/promises.lookup"),
  resolve: hostMocks.forbidden("dns/promises.resolve"),
  Resolver: hostMocks.forbidden("new dns/promises.Resolver"),
}));
vi.mock("node:dgram", () => ({
  createSocket: hostMocks.forbidden("dgram.createSocket"),
  Socket: hostMocks.forbidden("new dgram.Socket"),
}));

vi.stubGlobal("fetch", hostMocks.forbidden("global.fetch"));

const { LITERAL_ESCAPE_SEQUENCE, registerAudioFeedbackExtension } =
  await import("../extensions/index.js");
import type {
  ConfigurationFileSystem,
  LaunchableAudioCue,
  SchedulerChild,
} from "../extensions/index.js";

const ALLOWED_RUNTIME_MODULES = new Set([
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "node:child_process",
  "node:crypto",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:os",
  "node:path",
  "node:url",
]);
const FORBIDDEN_CAPABILITIES = new Set([
  "require",
  "createRequire",
  "eval",
  "Function",
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "sendBeacon",
  "getBuiltinModule",
  "_linkedBinding",
  "binding",
  "constructor",
  "__proto__",
]);
const FORBIDDEN_RUNTIME_ROOTS = new Set([
  "globalThis",
  "global",
  "window",
  "navigator",
  "Reflect",
  "Proxy",
  "eval",
  "Function",
  "WebAssembly",
]);
const ALLOWED_OBJECT_OPERATIONS = new Set(["freeze", "fromEntries", "keys"]);
const temporaryDirectories: string[] = [];

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

type Hook = (event: Readonly<Record<string, unknown>>, context: ExtensionContext) => unknown;
type Command = (args: string, context: ExtensionCommandContext) => unknown;
type TestComponent = { handleInput?(data: string): void; render?(width: number): string[] };

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
  readonly focusOverlay: ReturnType<typeof vi.fn>;
  activeComponentCount(): number;
}

function staticString(expression: ts.Expression): string | null {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left);
    const right = staticString(expression.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

function isChildProcessSpecifier(specifier: string): boolean {
  return (
    specifier === "node:child_process" ||
    specifier.startsWith("node:child_process/") ||
    specifier === "child_process" ||
    specifier.startsWith("child_process/")
  );
}

function assertChildProcessModuleBoundary(file: string, node: ts.Node, value: ts.Expression): void {
  if (!ts.isStringLiteralLike(value) || !isChildProcessSpecifier(value.text)) return;
  const approvedImport =
    ts.isImportDeclaration(node) &&
    normalize(file).endsWith("/extensions/platform-adapters.ts") &&
    value.text === "node:child_process";
  if (!approvedImport) {
    throw new Error(
      `${file}: child_process modules are restricted to platform-adapters.ts's approved import`,
    );
  }
}

function assertAllowedModuleSpecifier(
  file: string,
  extensionRoot: string,
  publishedFiles: ReadonlySet<string>,
  value: ts.Expression,
): void {
  if (!ts.isStringLiteralLike(value)) {
    throw new Error(`${file}: module specifier must be a string literal`);
  }
  const specifier = value.text;
  if (!specifier.startsWith(".")) {
    if (!ALLOWED_RUNTIME_MODULES.has(specifier)) {
      throw new Error(`${file}: runtime module is not allowlisted: ${specifier}`);
    }
    return;
  }
  const resolved = normalize(resolve(dirname(file), specifier)).replace(/\.js$/u, ".ts");
  if (!resolved.startsWith(`${extensionRoot}/`) || !publishedFiles.has(resolved)) {
    throw new Error(`${file}: relative module escapes or does not resolve: ${specifier}`);
  }
}

function compactNodeText(node: ts.Node, source: ts.SourceFile): string {
  return node
    .getText(source)
    .replace(/\s/gu, "")
    .replace(/,([\])}])/gu, "$1");
}

function assertPlatformChildProcessContract(file: string, source: ts.SourceFile): void {
  const isPlatformAdapter = normalize(file).endsWith("/extensions/platform-adapters.ts");
  const childProcessImports = source.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "node:child_process",
  );
  if (!isPlatformAdapter) {
    if (childProcessImports.length > 0) {
      throw new Error(`${file}: node:child_process is restricted to platform-adapters.ts`);
    }
    return;
  }

  if (childProcessImports.length !== 1) {
    throw new Error(`${file}: expected exactly one node:child_process import`);
  }
  const importClause = childProcessImports[0]?.importClause;
  const bindings = importClause?.namedBindings;
  if (
    importClause === undefined ||
    importClause.phaseModifier !== undefined ||
    importClause.name !== undefined ||
    bindings === undefined ||
    !ts.isNamedImports(bindings) ||
    bindings.elements.length !== 2
  ) {
    throw new Error(`${file}: child_process import must contain only spawn and SpawnOptions`);
  }
  const spawnImport = bindings.elements[0];
  const optionsImport = bindings.elements[1];
  if (
    spawnImport === undefined ||
    spawnImport.isTypeOnly ||
    spawnImport.propertyName?.text !== "spawn" ||
    spawnImport.name.text !== "nodeSpawn" ||
    optionsImport === undefined ||
    !optionsImport.isTypeOnly ||
    optionsImport.propertyName !== undefined ||
    optionsImport.name.text !== "SpawnOptions"
  ) {
    throw new Error(
      `${file}: child_process bindings must be spawn as nodeSpawn and type SpawnOptions`,
    );
  }

  const spawnOptionsDeclarations = source.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "spawnOptions",
  );
  const spawnOptionsText = spawnOptionsDeclarations[0]
    ? compactNodeText(spawnOptionsDeclarations[0], source)
    : "";
  const expectedSpawnOptions =
    'functionspawnOptions(wavPath:string):SpawnOptions{return{cwd:dirname(wavPath),env:process.env,stdio:"ignore",detached:false,windowsHide:true,shell:false};}';
  if (spawnOptionsDeclarations.length !== 1 || spawnOptionsText !== expectedSpawnOptions) {
    throw new Error(`${file}: common spawn options do not match PRD section 5.1`);
  }

  const nodeSpawnUses: ts.Identifier[] = [];
  const spawnPlayerUses: ts.Identifier[] = [];
  const privateSpawnPlayerUses: ts.PrivateIdentifier[] = [];
  const boundaryCalls: ts.CallExpression[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === "nodeSpawn") nodeSpawnUses.push(node);
    if (ts.isIdentifier(node) && node.text === "spawnPlayer") spawnPlayerUses.push(node);
    if (ts.isPrivateIdentifier(node) && node.text === "#spawnPlayer") {
      privateSpawnPlayerUses.push(node);
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        (ts.isIdentifier(callee) && callee.text === "spawnPlayer") ||
        (ts.isPropertyAccessExpression(callee) &&
          ts.isPrivateIdentifier(callee.name) &&
          callee.name.text === "#spawnPlayer")
      ) {
        boundaryCalls.push(node);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const isImportBinding = (identifier: ts.Identifier): boolean =>
    ts.isImportSpecifier(identifier.parent) && identifier.parent.name === identifier;
  const isDefaultInjection = (identifier: ts.Identifier): boolean => {
    const parameter = identifier.parent;
    if (!ts.isParameter(parameter) || parameter.initializer !== identifier) return false;
    if (!ts.isIdentifier(parameter.name) || parameter.name.text !== "spawnPlayer") return false;
    const declaration = parameter.parent;
    return (
      ts.isFunctionDeclaration(declaration) && declaration.name?.text === "selectPlatformPlayer"
    );
  };
  if (
    nodeSpawnUses.length !== 2 ||
    !nodeSpawnUses.some(isImportBinding) ||
    !nodeSpawnUses.some(isDefaultInjection)
  ) {
    throw new Error(
      `${file}: imported nodeSpawn may only be selectPlatformPlayer's default SpawnPlayer`,
    );
  }

  // These counts bind every production seam occurrence. An added alias, parameter, property access,
  // or generic exported launch path changes a count even when it keeps an approved executable text.
  if (spawnPlayerUses.length !== 6 || privateSpawnPlayerUses.length !== 4) {
    throw new Error(`${file}: SpawnPlayer boundary shape changed`);
  }

  const expectedCalls = new Set([
    'this.#spawnPlayer("paplay",[this.#wavPath],spawnOptions(this.#wavPath))',
    'this.#spawnPlayer("aplay",[this.#wavPath],spawnOptions(this.#wavPath))',
    'spawnPlayer("afplay",[cue.wavPath],spawnOptions(cue.wavPath))',
    'spawnPlayer("powershell.exe",["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",cue.powershellHelperPath,"-Path",cue.wavPath],spawnOptions(cue.wavPath))',
  ]);
  const actualCalls = boundaryCalls.map((call) => compactNodeText(call, source));
  if (
    actualCalls.length !== expectedCalls.size ||
    actualCalls.some((call) => !expectedCalls.has(call)) ||
    new Set(actualCalls).size !== expectedCalls.size
  ) {
    throw new Error(
      `${file}: player launch sites do not match the closed executable/argument contract`,
    );
  }
}

function assertNoRuntimeCapability(
  file: string,
  source: ts.SourceFile,
  extensionRoot: string,
  publishedFiles: ReadonlySet<string>,
): void {
  assertPlatformChildProcessContract(file, source);

  const visit = (node: ts.Node): void => {
    // Inspect module-bearing syntax at the specifier boundary before the general allowlist. This
    // prevents child_process from being laundered by a re-export or type/import syntax that does
    // not create an ImportDeclaration.
    let moduleSpecifier: ts.Expression | undefined;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined
    ) {
      moduleSpecifier = node.moduleSpecifier;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      moduleSpecifier = node.moduleReference.expression;
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      moduleSpecifier = node.argument.literal;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      moduleSpecifier = node.arguments[0];
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      moduleSpecifier = node.name;
    }
    if (moduleSpecifier !== undefined) {
      assertChildProcessModuleBoundary(file, node, moduleSpecifier);
      assertAllowedModuleSpecifier(file, extensionRoot, publishedFiles, moduleSpecifier);
    }
    if (ts.isImportEqualsDeclaration(node)) {
      throw new Error(`${file}: import-equals is forbidden`);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      throw new Error(`${file}: dynamic import is forbidden`);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_RUNTIME_ROOTS.has(node.text)) {
      throw new Error(`${file}: forbidden runtime root or syntax: ${node.text}`);
    }
    if (ts.isIdentifier(node) && FORBIDDEN_CAPABILITIES.has(node.text)) {
      throw new Error(`${file}: forbidden runtime capability: ${node.text}`);
    }
    if (ts.isIdentifier(node) && node.text === "Object") {
      const parent = node.parent;
      if (
        !ts.isPropertyAccessExpression(parent) ||
        parent.expression !== node ||
        !ALLOWED_OBJECT_OPERATIONS.has(parent.name.text)
      ) {
        throw new Error(`${file}: Object reflection or aliasing is forbidden`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_CAPABILITIES.has(node.name.text)) {
      throw new Error(`${file}: forbidden runtime property: ${node.name.text}`);
    }
    if (ts.isElementAccessExpression(node)) {
      const property = staticString(node.argumentExpression);
      if (property !== null && FORBIDDEN_CAPABILITIES.has(property)) {
        throw new Error(`${file}: forbidden computed runtime property: ${property}`);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "Object") {
        throw new Error(`${file}: computed Object access is forbidden`);
      }
      if (
        property === null &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "module" || node.expression.text === "process")
      ) {
        throw new Error(`${file}: dynamic loader property access is forbidden`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function parseFixture(name: string, sourceText: string): ts.SourceFile {
  return ts.createSourceFile(name, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

async function loadPublishedExtensionGraph(extensionRoot: string): Promise<Map<string, string>> {
  const collectTypeScriptFiles = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return collectTypeScriptFiles(path);
        return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
      }),
    );
    return nested.flat();
  };
  const graph = new Map<string, string>();
  for (const file of (await collectTypeScriptFiles(extensionRoot)).sort()) {
    graph.set(file, await nodeFileSystem.readFile(file, "utf8"));
  }
  return graph;
}

function assertPublishedExtensionGraph(
  extensionRoot: string,
  publishedSource: ReadonlyMap<string, string>,
): void {
  const publishedFiles = new Set(publishedSource.keys());
  for (const [file, sourceText] of publishedSource) {
    assertNoRuntimeCapability(file, parseFixture(file, sourceText), extensionRoot, publishedFiles);
  }
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
  const focusOverlay = vi.fn();
  let activeComponents = 0;
  let timerId = 0;
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
        options?: { onHandle?(handle: { focus(): void }): void },
      ): Promise<T> =>
        new Promise<T>((resolve) => {
          options?.onHandle?.({ focus: focusOverlay });
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
    focusOverlay,
    activeComponentCount: () => activeComponents,
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
  expect(harness.activeTimers.size).toBe(0);
  for (const child of harness.children) {
    expect(child.eventNames()).toEqual([]);
    expect(child.listenerCount("spawn")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.listenerCount("close")).toBe(0);
  }
}

async function shutdownAndAssertClean(
  harness: RuntimeHarness,
  expectedTerminalDisposals = 1,
): Promise<void> {
  const liveChildren = harness.children.filter((child) => child.eventNames().length > 0);
  await expect(
    invoke(harness, "session_shutdown", { type: "session_shutdown", reason: "quit" }),
  ).resolves.toBeUndefined();
  assertPlayerResourcesClean(harness);
  for (const child of liveChildren) expect(child.kill).toHaveBeenCalledOnce();
  expect(harness.terminalListeners.size).toBe(0);
  expect(harness.removeTerminalListener).toHaveBeenCalledTimes(expectedTerminalDisposals);
  expect(harness.activeComponentCount()).toBe(0);
}

beforeEach(() => {
  vi.stubGlobal("fetch", hostMocks.forbidden("global.fetch"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  hostMocks.networkCalls.splice(0);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("runtime privacy and output containment", () => {
  it("allows only the closed published runtime graph and rejects loader/network escapes", async () => {
    const extensionRoot = fileURLToPath(new URL("../extensions", import.meta.url));
    const publishedSource = await loadPublishedExtensionGraph(extensionRoot);
    const files = [...publishedSource.keys()];
    expect(files.map((file) => file.slice(extensionRoot.length + 1))).toEqual([
      "audio-catalog.ts",
      "config.ts",
      "eligibility.ts",
      "index.ts",
      "platform-adapters.ts",
      "scheduler.ts",
      "settings.ts",
      "terminal-outcomes.ts",
    ]);
    const publishedFiles = new Set(files);
    assertPublishedExtensionGraph(extensionRoot, publishedSource);

    const adversarialFixtures = [
      'import * as transport from "node:http"; transport.get("x")',
      'import { request as send } from "node:https"; send("x")',
      'import { createRequire as cr } from "node:module"; const r = cr(import.meta.url); r("node:https")',
      'const { fetch: f } = globalThis; f("https://example.invalid")',
      'const get = Reflect.get; const apply = Reflect.apply; const f = get(globalThis, "fetch"); apply(f, undefined, ["https://example.invalid"])',
      'const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch"); descriptor?.value("https://example.invalid")',
      'const O = Object; const key = "getOwn" + "PropertyDescriptor"; O[key](globalThis, "fetch")',
      'const R = Reflect; R["g" + "et"](globalThis, "fetch")',
      'const f = globalThis["fe" + "tch"]; f("https://example.invalid")',
      'const globals = globalThis; const key = "fetch"; globals[key]("https://example.invalid")',
      '(0, eval)("source")',
      'const C = Function; C("source")',
      'new (globalThis["Fun" + "ction"])("source")',
      'const indirectEval = eval; indirectEval("source")',
      'const IndirectFunction = Function; new IndirectFunction("source")',
      'const Wrapped = new Proxy(Function, {}); new Wrapped("source")',
      'WebAssembly.instantiateStreaming(fetch("module.wasm"))',
      'void import("node:http")',
      'export * from "node:child_process"',
      'export { spawn as escapedSpawn } from "child_process"',
      'import child = require("node:child_process")',
      'type Spawn = typeof import("node:child_process").spawn',
      'const load = require; load("node:http")',
      'const cr = module["create" + "Require"]; cr(import.meta.url)',
      ...["node:http2", "node:tls", "node:dns", "node:dns/promises", "node:dgram"].map(
        (specifier) => `import * as boundary from "${specifier}"; void boundary`,
      ),
      'const { WebSocket: SocketAlias } = globalThis; new SocketAlias("wss://example.invalid")',
      'navigator["send" + "Beacon"]("https://example.invalid")',
      "new XMLHttpRequest()",
    ];
    for (const [index, fixture] of adversarialFixtures.entries()) {
      let rejected = false;
      try {
        assertNoRuntimeCapability(
          `fixture-${String(index)}.ts`,
          parseFixture(`fixture-${String(index)}.ts`, fixture),
          extensionRoot,
          publishedFiles,
        );
      } catch {
        rejected = true;
      }
      expect(rejected, `analyzer accepted adversarial fixture: ${fixture}`).toBe(true);
    }

    const platformAdapterPath = join(extensionRoot, "platform-adapters.ts");
    const platformAdapterSource = publishedSource.get(platformAdapterPath);
    expect(platformAdapterSource).toBeDefined();
    if (platformAdapterSource === undefined) throw new Error("platform adapter source missing");
    const childProcessMutations = [
      `${platformAdapterSource}\nexport const escape = () => nodeSpawn("curl", ["https://example.invalid"], {});`,
      `${platformAdapterSource}\nconst run = nodeSpawn; export const escape = () => run("curl", [], {});`,
      platformAdapterSource.replace(
        'import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";',
        'import { spawn as nodeSpawn, exec, type SpawnOptions } from "node:child_process";',
      ),
      platformAdapterSource.replace(
        'import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";',
        'import { spawn as nodeSpawn, execFile, type SpawnOptions } from "node:child_process";',
      ),
      platformAdapterSource.replace(
        'import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";',
        'import { spawn as nodeSpawn, fork, type SpawnOptions } from "node:child_process";',
      ),
      platformAdapterSource.replace("shell: false", "shell: true"),
      platformAdapterSource.replace('stdio: "ignore"', 'stdio: "inherit"'),
      platformAdapterSource.replace('spawnPlayer("afplay",', "spawnPlayer(executable,"),
      platformAdapterSource.replace(
        "[cue.wavPath], spawnOptions(cue.wavPath)",
        '["--url", cue.wavPath], spawnOptions(cue.wavPath)',
      ),
      `${platformAdapterSource}\nexport const genericSpawn = (spawnPlayer: SpawnPlayer, executable: string) => spawnPlayer(executable, [], {});`,
    ];
    for (const mutation of childProcessMutations) {
      expect(() => {
        assertNoRuntimeCapability(
          platformAdapterPath,
          parseFixture(platformAdapterPath, mutation),
          extensionRoot,
          publishedFiles,
        );
      }).toThrow();
    }
  });

  it("rejects multi-file child_process re-export laundering across the published graph", async () => {
    const extensionRoot = fileURLToPath(new URL("../extensions", import.meta.url));
    const publishedSource = await loadPublishedExtensionGraph(extensionRoot);
    const platformAdapterPath = join(extensionRoot, "platform-adapters.ts");
    const importerPath = join(extensionRoot, "index.ts");
    const platformAdapterSource = publishedSource.get(platformAdapterPath);
    const importerSource = publishedSource.get(importerPath);
    expect(platformAdapterSource).toBeDefined();
    expect(importerSource).toBeDefined();
    if (platformAdapterSource === undefined || importerSource === undefined) {
      throw new Error("Published multi-file fixture sources are missing");
    }

    const launderingVariants = [
      { reExport: 'export { spawn } from "node:child_process";', binding: "spawn" },
      {
        reExport: 'export { spawn as escapedSpawn } from "node:child_process";',
        binding: "escapedSpawn",
      },
      { reExport: 'export * from "node:child_process";', binding: "spawn" },
      { reExport: "export { nodeSpawn as escapedSpawn };", binding: "escapedSpawn" },
    ];
    for (const { reExport, binding } of launderingVariants) {
      const mutation = new Map(publishedSource);
      mutation.set(platformAdapterPath, `${platformAdapterSource}\n${reExport}`);
      mutation.set(
        importerPath,
        `${importerSource}\nimport { ${binding} } from "./platform-adapters.js";\nexport const dormantNetworkLaunch = () => ${binding}("curl", ["https://example.invalid"], {});`,
      );
      expect(() => {
        assertPublishedExtensionGraph(extensionRoot, mutation);
      }, `analyzer accepted multi-file child_process laundering: ${reExport}`).toThrow(
        /child_process|imported nodeSpawn/u,
      );
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
      const requestsBeforeMutation = [...harness.starts];
      component?.handleInput?.("enter");
      await vi.waitFor(() => {
        expect(harness.notifications).toEqual([
          "Audio settings could not be saved; the previous value was restored.",
        ]);
      });
      expect(harness.starts).toEqual([...requestsBeforeMutation, "settingsToggleOff"]);
      expect(harness.children).toHaveLength(3);
      const toggleOff = harness.children.at(-1);
      toggleOff?.emit("spawn");
      toggleOff?.emit("close", 0, null);
      await flush();

      // The failed all-off mutation also leaves the real store's in-memory toggles unchanged.
      component?.handleInput?.("down");
      await flush();
      component?.handleInput?.("enter");
      await vi.waitFor(() => {
        expect(component?.render?.(120).some((line) => line.endsWith("appStart [on]"))).toBe(true);
      });
      expect(harness.notifications).toHaveLength(1);
      component?.handleInput?.("escape");
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

  it("clears the Settings singleton after close and opens a fresh custom component", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio settings reopen "));
    temporaryDirectories.push(directory);
    const harness = createRuntimeHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "new" });

    const firstCommand = Promise.resolve(
      harness.command("", harness.context as ExtensionCommandContext),
    );
    await vi.waitFor(() => {
      expect(harness.components).toHaveLength(1);
    });
    harness.components[0]?.handleInput?.("escape");
    await firstCommand;
    expect(harness.activeComponentCount()).toBe(0);

    const secondCommand = Promise.resolve(
      harness.command("", harness.context as ExtensionCommandContext),
    );
    await vi.waitFor(() => {
      expect(harness.components).toHaveLength(2);
    });
    expect(harness.activeComponentCount()).toBe(1);
    await harness.command("", harness.context as ExtensionCommandContext);
    expect(harness.focusOverlay).toHaveBeenCalledOnce();
    harness.components[1]?.handleInput?.("escape");
    await secondCommand;
    for (const child of harness.children) child.emit("error", new Error("fixture cleanup"));
    await flush();
    await shutdownAndAssertClean(harness);
  });

  it("disposes open Settings on shutdown without retaining a stale controller", async () => {
    const directory = await mkdtemp(join(tmpdir(), "audio settings shutdown "));
    temporaryDirectories.push(directory);
    const harness = createRuntimeHarness(directory);
    await invoke(harness, "session_start", { type: "session_start", reason: "new" });
    const openCommand = Promise.resolve(
      harness.command("", harness.context as ExtensionCommandContext),
    );
    await vi.waitFor(() => {
      expect(harness.activeComponentCount()).toBe(1);
    });

    await shutdownAndAssertClean(harness);
    await openCommand;
    const focusCount = harness.focusOverlay.mock.calls.length;
    await harness.command("", harness.context as ExtensionCommandContext);
    expect(harness.components).toHaveLength(1);
    expect(harness.focusOverlay).toHaveBeenCalledTimes(focusCount);

    await invoke(harness, "session_start", { type: "session_start", reason: "new" });
    expect(harness.terminalListeners.size).toBe(1);
    const freshCommand = Promise.resolve(
      harness.command("", harness.context as ExtensionCommandContext),
    );
    await vi.waitFor(() => {
      expect(harness.components).toHaveLength(2);
    });
    expect(harness.activeComponentCount()).toBe(1);
    await shutdownAndAssertClean(harness, 2);
    await freshCommand;
    expect(harness.activeTimers.size).toBe(0);
    for (const child of harness.children) expect(child.eventNames()).toEqual([]);
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
