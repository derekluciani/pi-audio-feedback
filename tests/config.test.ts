import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_EVENTS,
  CONFIG_FILE_NAME,
  ConfigurationStore,
  DEFAULT_CONFIGURATION,
  getConfigurationPath,
  type ConfigurationFileHandle,
  type ConfigurationFileSystem,
} from "../extensions/config.js";

const temporaryDirectories: string[] = [];

const realFileSystem: ConfigurationFileSystem = {
  lstat,
  readFile,
  mkdir,
  open: async (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
};

async function temporaryConfigPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-audio-config-"));
  temporaryDirectories.push(root);
  return join(root, "agent", CONFIG_FILE_NAME);
}

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected persisted JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("configuration loading and validation", () => {
  it("uses exact defaults and a global agent-directory path without creating a missing file", async () => {
    const path = await temporaryConfigPath();
    const store = new ConfigurationStore({ path });

    expect(getConfigurationPath("/global/pi-agent")).toBe(
      join("/global/pi-agent", CONFIG_FILE_NAME),
    );
    expect((await store.load()).configuration).toEqual(DEFAULT_CONFIGURATION);
    expect(store.current.classification).toBe("missing");
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("defaults partial, wrong-type, and unknown-theme fields independently", async () => {
    const path = await temporaryConfigPath();
    await writeConfig(path, {
      theme: "not-installed",
      events: { appStart: false, agentStart: "no", toolError: false },
    });

    const loaded = await new ConfigurationStore({ path }).load();
    expect(loaded.classification).toBe("valid");
    expect(loaded.configuration.theme).toBe("core");
    expect(loaded.configuration.events.appStart).toBe(false);
    expect(loaded.configuration.events.agentStart).toBe(true);
    expect(loaded.configuration.events.toolError).toBe(false);
    expect(loaded.configuration.events.agentSettled).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["malformed", "{"],
    ["older version", { version: 0, theme: "retro" }],
  ])("classifies %s content as replaceable malformed defaults", async (_name, source) => {
    const path = await temporaryConfigPath();
    await writeConfig(path, source);
    const original = await readFile(path, "utf8");
    const store = new ConfigurationStore({ path });

    const loaded = await store.load();
    expect(loaded.classification).toBe("malformed");
    expect(loaded.warning).toBe("malformed");
    expect(loaded.configuration).toEqual(DEFAULT_CONFIGURATION);
    expect(await readFile(path, "utf8")).toBe(original);

    expect(await store.mutate({ theme: "soft" })).toMatchObject({ ok: true });
    expect((await readJson(path)).theme).toBe("soft");
  });

  it("preserves a newer version and rejects a destructive downgrade", async () => {
    const path = await temporaryConfigPath();
    const source = '{"version":2,"future":true}\n';
    await writeConfig(path, source);
    const store = new ConfigurationStore({ path });

    expect(await store.load()).toMatchObject({
      classification: "unsupported-version",
      warning: "unsupported-version",
      configuration: DEFAULT_CONFIGURATION,
    });
    expect(await store.mutate({ theme: "retro" })).toEqual({
      ok: false,
      reason: "not-writable",
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("rejects symlink paths while preserving the link and target", async () => {
    const path = await temporaryConfigPath();
    const target = join(path, "..", "target.json");
    await writeConfig(target, { version: 1, theme: "retro" });
    await symlink(target, path);
    const store = new ConfigurationStore({ path });

    expect(await store.load()).toMatchObject({ classification: "symlink", warning: "symlink" });
    expect(await store.mutate({ theme: "soft" })).toEqual({
      ok: false,
      reason: "not-writable",
    });
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect((await readJson(target)).theme).toBe("retro");
  });

  it("classifies unreadable paths without leaking filesystem errors and rejects writes", async () => {
    const path = await temporaryConfigPath();
    await writeConfig(path, { version: 1, theme: "retro" });
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const fileSystem: ConfigurationFileSystem = {
      ...realFileSystem,
      readFile: async () =>
        Promise.reject(Object.assign(new Error("private path"), { code: "EACCES" })),
    };
    const store = new ConfigurationStore({ path, fileSystem });

    expect(await store.load()).toMatchObject({
      path,
      classification: "unreadable",
      warning: "unreadable",
      configuration: DEFAULT_CONFIGURATION,
    });
    expect(await store.mutate({ theme: "soft" })).toEqual({
      ok: false,
      reason: "not-writable",
    });
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("atomic configuration mutations", () => {
  it("creates the first file with a trailing newline and restrictive POSIX permissions", async () => {
    const path = await temporaryConfigPath();
    const store = new ConfigurationStore({ path, platform: "linux" });

    expect(await store.mutate({ events: { appStart: false } })).toMatchObject({ ok: true });
    const source = await readFile(path, "utf8");
    expect(source.endsWith("\n")).toBe(true);
    expect((await readJson(path)).events).toMatchObject({ appStart: false, agentStart: true });
    expect((await stat(join(path, ".."))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("preserves unknown root fields and events on valid version-1 writes", async () => {
    const path = await temporaryConfigPath();
    await writeConfig(path, {
      version: 1,
      theme: "retro",
      futureRoot: { retained: true },
      events: { appStart: false, futureCue: "retained" },
    });
    const store = new ConfigurationStore({ path });

    expect(await store.mutate({ events: { toolError: false } })).toMatchObject({ ok: true });
    const persisted = await readJson(path);
    expect(persisted.futureRoot).toEqual({ retained: true });
    expect(persisted.events).toMatchObject({
      appStart: false,
      toolError: false,
      futureCue: "retained",
    });
    expect(Object.keys(store.current.configuration.events)).toEqual(AUDIO_EVENTS);
  });

  it("re-reads before every serialized mutation for completed last-writer-wins behavior", async () => {
    const path = await temporaryConfigPath();
    const firstStore = new ConfigurationStore({ path });
    await firstStore.mutate({ theme: "retro" });

    const externalStore = new ConfigurationStore({ path });
    await externalStore.mutate({ events: { appStart: false } });
    const first = firstStore.mutate({ theme: "organic" });
    const second = firstStore.mutate({ theme: "soft" });
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });

    const persisted = await readJson(path);
    expect(persisted.theme).toBe("soft");
    expect(persisted.events).toMatchObject({ appStart: false });
  });

  it("reloads disk changes for a later session", async () => {
    const path = await temporaryConfigPath();
    const store = new ConfigurationStore({ path });
    await store.mutate({ theme: "retro" });
    await writeConfig(path, { version: 1, theme: "organic", events: { appStart: false } });

    const reloaded = await store.load();
    expect(reloaded.configuration.theme).toBe("organic");
    expect(reloaded.configuration.events.appStart).toBe(false);
  });

  it("writes, flushes, closes, and atomically renames a unique same-directory temp", async () => {
    const path = await temporaryConfigPath();
    await writeConfig(path, { version: 1, theme: "core" });
    const steps: string[] = [];
    const themesBeforeWrite = ["core", "retro"];
    const temporaryPaths: string[] = [];
    const fileSystem: ConfigurationFileSystem = {
      ...realFileSystem,
      open: async (openedPath, flags, mode) => {
        const handle = await open(openedPath, flags, mode);
        if (flags === "r") return handle;
        temporaryPaths.push(openedPath);
        const wrapped: ConfigurationFileHandle = {
          writeFile: async (data, encoding) => {
            expect((await readJson(path)).theme).toBe(themesBeforeWrite.shift());
            steps.push("write");
            await handle.writeFile(data, encoding);
          },
          sync: async () => {
            steps.push("flush");
            await handle.sync();
          },
          close: async () => {
            steps.push("close");
            await handle.close();
          },
        };
        return wrapped;
      },
      rename: async (oldPath, newPath) => {
        steps.push("rename");
        await rename(oldPath, newPath);
      },
    };
    let id = 0;
    const store = new ConfigurationStore({
      path,
      fileSystem,
      uniqueId: () => `id-${String(++id)}`,
    });

    await store.mutate({ theme: "retro" });
    await store.mutate({ theme: "soft" });
    expect(steps.slice(0, 4)).toEqual(["write", "flush", "close", "rename"]);
    expect(new Set(temporaryPaths).size).toBe(2);
    expect(temporaryPaths.every((temp) => join(temp, "..") == join(path, ".."))).toBe(true);
    expect((await readJson(path)).theme).toBe("soft");
  });

  it.each(["write", "rename"] as const)(
    "retains prior memory and disk state after a failed %s",
    async (failure) => {
      const path = await temporaryConfigPath();
      await writeConfig(path, { version: 1, theme: "retro" });
      const fileSystem: ConfigurationFileSystem = {
        ...realFileSystem,
        ...(failure === "rename"
          ? { rename: async () => Promise.reject(new Error("rename failed")) }
          : {
              open: async (openedPath: string, flags: "wx" | "r", mode?: number) => {
                const handle = await open(openedPath, flags, mode);
                if (flags === "r") return handle;
                return {
                  writeFile: async () => Promise.reject(new Error("write failed")),
                  sync: async () => handle.sync(),
                  close: async () => handle.close(),
                };
              },
            }),
      };
      const store = new ConfigurationStore({ path, fileSystem });
      await store.load();

      expect(await store.mutate({ theme: "soft" })).toEqual({
        ok: false,
        reason: "write-failed",
      });
      expect(store.current.configuration.theme).toBe("retro");
      expect((await readJson(path)).theme).toBe("retro");
    },
  );

  it("rejects invalid complete merges without touching disk or memory", async () => {
    const path = await temporaryConfigPath();
    const store = new ConfigurationStore({ path });
    await store.mutate({ theme: "retro" });
    const original = await readFile(path, "utf8");

    expect(await store.mutate({ theme: "unknown" })).toEqual({
      ok: false,
      reason: "invalid-mutation",
    });
    expect(await store.mutate({ events: { appStart: "false" } })).toEqual({
      ok: false,
      reason: "invalid-mutation",
    });
    expect(store.current.configuration.theme).toBe("retro");
    expect(await readFile(path, "utf8")).toBe(original);
  });
});
