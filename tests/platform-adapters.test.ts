import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { LaunchableAudioCue } from "../src/eligibility.js";
import { selectPlatformPlayer, type SpawnPlayer } from "../src/platform-adapters.js";
import { AudioScheduler, type SchedulerChild } from "../src/scheduler.js";

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

function cue(wavPath: string, helper?: string): LaunchableAudioCue {
  return {
    launchable: true,
    event: "appStart",
    priority: 1,
    theme: "core",
    wavPath,
    ...(helper === undefined ? {} : { powershellHelperPath: helper }),
  };
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function spawnHarness(): {
  calls: Array<{ executable: string; args: readonly string[]; options: unknown }>;
  children: FakeChild[];
  spawnPlayer: SpawnPlayer;
} {
  const calls: Array<{ executable: string; args: readonly string[]; options: unknown }> = [];
  const children: FakeChild[] = [];
  return {
    calls,
    children,
    spawnPlayer: (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  };
}

function childAt(children: FakeChild[], index: number): FakeChild {
  const child = children[index];
  if (child === undefined) throw new Error(`Missing child ${String(index)}`);
  return child;
}

async function flushLifecycle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function emitDuringRegistration(
  child: FakeChild,
  watchedEvent: "error" | "spawn" | "close",
  emit: (listener: (...args: unknown[]) => void) => void,
): void {
  const registrationListener = (
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ): void => {
    if (event !== watchedEvent) return;
    child.removeListener("newListener", registrationListener);
    emit(listener);
  };
  child.on("newListener", registrationListener);
}

function expectCommonOptions(options: unknown, wavPath: string): void {
  expect(options).toEqual({
    cwd: dirname(wavPath),
    env: process.env,
    stdio: "ignore",
    detached: false,
    windowsHide: true,
    shell: false,
  });
  expect((options as { env: unknown }).env).toBe(process.env);
}

describe("platform adapter contracts", () => {
  it.each(["/tmp/audio with spaces/cue.wav", "/tmp/audio's/cue.wav", "/tmp/日本語/通知.wav"])(
    "passes macOS path as one uninterpolated argument: %s",
    (wavPath) => {
      const h = spawnHarness();
      const launch = selectPlatformPlayer("darwin", h.spawnPlayer);
      expect(launch).not.toBeNull();
      launch?.(cue(wavPath));
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]).toMatchObject({ executable: "afplay", args: [wavPath] });
      expectCommonOptions(h.calls[0]?.options, wavPath);
    },
  );

  it("uses exact Windows PowerShell 5.1 executable and separate path arguments", () => {
    const wavPath = "C:\\Audio's 日本語\\cue sound.wav";
    const helper = "C:\\Program Files\\pi audio\\play-wav.ps1";
    const h = spawnHarness();
    const launch = selectPlatformPlayer("win32", h.spawnPlayer);
    launch?.(cue(wavPath, helper));
    expect(h.calls[0]).toMatchObject({
      executable: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        helper,
        "-Path",
        wavPath,
      ],
    });
    expectCommonOptions(h.calls[0]?.options, wavPath);
  });

  it("contains unsupported platforms without spawning and requires the validated Windows helper", () => {
    const spawnPlayer = vi.fn<SpawnPlayer>();
    expect(selectPlatformPlayer("freebsd", spawnPlayer)).toBeNull();
    expect(selectPlatformPlayer("aix", spawnPlayer)).toBeNull();
    expect(spawnPlayer).not.toHaveBeenCalled();
    expect(() => selectPlatformPlayer("win32", spawnPlayer)?.(cue("C:\\cue.wav"))).toThrow(
      "Validated Windows PowerShell helper path is required",
    );
    expect(spawnPlayer).not.toHaveBeenCalled();
  });

  it("uses ignored stdio so success, errors, and nonzero closes cannot leak output", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const h = spawnHarness();
      const player = selectPlatformPlayer(
        platform,
        h.spawnPlayer,
      )?.(cue("/tmp/noisy cue.wav", "/tmp/play-wav.ps1"));
      expect(h.calls[0]?.options).toMatchObject({ stdio: "ignore" });
      player?.on("error", () => undefined);
      childAt(h.children, 0).emit("spawn");
      childAt(h.children, 0).emit("close", 9, null);
      expect(h.calls).toHaveLength(1);
    }
  });
});

describe("Linux ENOENT-only fallback facade", () => {
  it("falls back exactly once after asynchronous pre-spawn paplay ENOENT", async () => {
    const h = spawnHarness();
    const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/a b's 日本語.wav"));
    const events: string[] = [];
    logical?.on("spawn", () => events.push("spawn"));
    logical?.on("error", () => events.push("error"));
    logical?.on("close", (code) => events.push(`close:${String(code)}`));

    childAt(h.children, 0).emit("error", enoent());
    childAt(h.children, 0).emit("close", 1, null);
    expect(h.calls.map(({ executable, args }) => [executable, args])).toEqual([
      ["paplay", ["/tmp/a b's 日本語.wav"]],
      ["aplay", ["/tmp/a b's 日本語.wav"]],
    ]);
    expect(events).toEqual([]);

    childAt(h.children, 1).emit("spawn");
    childAt(h.children, 1).emit("close", 0, null);
    await flushLifecycle();
    expect(events).toEqual(["spawn", "close:0"]);
    expectCommonOptions(h.calls[1]?.options, "/tmp/a b's 日本語.wav");
  });

  it("falls back on synchronous paplay ENOENT but not other synchronous errors", () => {
    const fallback = spawnHarness();
    const delegated: SpawnPlayer = (executable, args, options) => {
      if (executable === "paplay") throw enoent();
      return fallback.spawnPlayer(executable, args, options);
    };
    expect(() => selectPlatformPlayer("linux", delegated)?.(cue("/tmp/cue.wav"))).not.toThrow();
    expect(fallback.calls[0]?.executable).toBe("aplay");

    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    const nonEnoent = vi.fn<SpawnPlayer>(() => {
      throw denied;
    });
    expect(() => selectPlatformPlayer("linux", nonEnoent)?.(cue("/tmp/cue.wav"))).toThrow(denied);
    expect(nonEnoent).toHaveBeenCalledOnce();
  });

  it.each(["EACCES", "EPERM"])("does not fallback for pre-spawn %s", async (code) => {
    const h = spawnHarness();
    const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/cue.wav"));
    const errors: Error[] = [];
    logical?.on("error", (error) => errors.push(error));
    childAt(h.children, 0).emit("error", Object.assign(new Error(code), { code }));
    childAt(h.children, 0).emit("close", 1, null);
    expect(h.calls.map(({ executable }) => executable)).toEqual(["paplay"]);
    await flushLifecycle();
    expect(errors).toHaveLength(1);
  });

  it("never falls back after spawn, child error, or nonzero close and settles once", async () => {
    for (const terminal of ["error", "close"] as const) {
      const h = spawnHarness();
      const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/cue.wav"));
      const terminals: string[] = [];
      logical?.on("error", () => terminals.push("error"));
      logical?.on("close", () => terminals.push("close"));
      const primary = childAt(h.children, 0);
      primary.emit("spawn");
      if (terminal === "error") primary.emit("error", enoent());
      else primary.emit("close", 17, null);
      primary.emit("close", 17, null);
      expect(h.calls.map(({ executable }) => executable)).toEqual(["paplay"]);
      await flushLifecycle();
      expect(terminals).toEqual([terminal]);
    }
  });

  it("kills only the currently active direct player and ignores kill failure", () => {
    const h = spawnHarness();
    const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/cue.wav"));
    childAt(h.children, 0).emit("error", enoent());
    childAt(h.children, 1).kill.mockImplementation(() => {
      throw new Error("already gone");
    });
    expect(() => logical?.kill()).not.toThrow();
    expect(childAt(h.children, 0).kill).not.toHaveBeenCalled();
    expect(childAt(h.children, 1).kill).toHaveBeenCalledOnce();
  });

  it("defers synchronous registration lifecycle and removes every direct listener", async () => {
    const direct = new FakeChild();
    emitDuringRegistration(direct, "close", (listener) => {
      listener(0, null);
    });
    const spawnPlayer = vi.fn<SpawnPlayer>(() => direct);
    const logical = selectPlatformPlayer("linux", spawnPlayer)?.(cue("/tmp/cue.wav"));
    const events: string[] = [];
    logical?.on("spawn", () => events.push("spawn"));
    logical?.on("close", () => events.push("close"));

    expect(events).toEqual([]);
    await flushLifecycle();
    expect(events).toEqual(["close"]);
    expect(direct.listenerCount("error")).toBe(0);
    expect(direct.listenerCount("spawn")).toBe(0);
    expect(direct.listenerCount("close")).toBe(0);
  });

  it("forwards at most one logical spawn and terminal under duplicate and late events", async () => {
    const h = spawnHarness();
    const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/cue.wav"));
    const events: string[] = [];
    logical?.on("spawn", () => events.push("spawn"));
    logical?.on("error", () => events.push("error"));
    logical?.on("close", () => events.push("close"));
    const direct = childAt(h.children, 0);

    const lateError = direct.listeners("error")[0];
    direct.emit("spawn");
    direct.emit("spawn");
    direct.emit("close", 0, null);
    lateError?.(new Error("late"));
    direct.emit("close", 1, null);
    await flushLifecycle();
    direct.emit("spawn");
    lateError?.(new Error("later"));
    direct.emit("close", 2, null);
    await flushLifecycle();

    expect(events).toEqual(["spawn", "close"]);
    expect(direct.listenerCount("error")).toBe(0);
    expect(direct.listenerCount("spawn")).toBe(0);
    expect(direct.listenerCount("close")).toBe(0);
  });

  it("handles synchronous primary ENOENT registration and cleans the replaced child", async () => {
    const primary = new FakeChild();
    const fallback = new FakeChild();
    emitDuringRegistration(primary, "error", (listener) => {
      listener(enoent());
    });
    const calls: string[] = [];
    const spawnPlayer: SpawnPlayer = (executable) => {
      calls.push(executable);
      return executable === "paplay" ? primary : fallback;
    };
    const logical = selectPlatformPlayer("linux", spawnPlayer)?.(cue("/tmp/cue.wav"));
    const events: string[] = [];
    logical?.on("close", () => events.push("close"));
    fallback.emit("close", 0, null);
    await flushLifecycle();

    expect(calls).toEqual(["paplay", "aplay"]);
    expect(events).toEqual(["close"]);
    expect(primary.listenerCount("error")).toBe(0);
    expect(primary.listenerCount("spawn")).toBe(0);
    expect(primary.listenerCount("close")).toBe(0);
  });

  it("contains fallback throws from async ENOENT and preserves synchronous throw behavior", async () => {
    const primary = new FakeChild();
    const fallbackFailure = new Error("fallback failed");
    const asyncSpawn: SpawnPlayer = (executable) => {
      if (executable === "paplay") return primary;
      throw fallbackFailure;
    };
    const logical = selectPlatformPlayer("linux", asyncSpawn)?.(cue("/tmp/cue.wav"));
    const errors: Error[] = [];
    logical?.on("error", (error) => errors.push(error));
    expect(() => primary.emit("error", enoent())).not.toThrow();
    await flushLifecycle();
    expect(errors).toEqual([fallbackFailure]);

    const synchronousSpawn: SpawnPlayer = (executable) => {
      if (executable === "paplay") throw enoent();
      throw fallbackFailure;
    };
    expect(() => selectPlatformPlayer("linux", synchronousSpawn)?.(cue("/tmp/cue.wav"))).toThrow(
      fallbackFailure,
    );
  });

  it("settles once when the fallback emits duplicate asynchronous errors", async () => {
    const h = spawnHarness();
    const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/cue.wav"));
    const errors: Error[] = [];
    logical?.on("error", (error) => errors.push(error));
    childAt(h.children, 0).emit("error", enoent());
    const fallback = childAt(h.children, 1);
    const failure = new Error("aplay failed");
    const duplicateError = fallback.listeners("error")[0];
    fallback.emit("error", failure);
    duplicateError?.(new Error("duplicate"));
    fallback.emit("close", 1, null);
    await flushLifecycle();
    expect(errors).toEqual([failure]);
  });

  it("makes kill safe before fallback, during fallback creation, and before queued delivery", async () => {
    const before = spawnHarness();
    const beforeLogical = selectPlatformPlayer("linux", before.spawnPlayer)?.(cue("/tmp/cue.wav"));
    const latePrimaryError = childAt(before.children, 0).listeners("error")[0];
    expect(beforeLogical?.kill()).toBe(true);
    latePrimaryError?.(enoent());
    expect(before.calls.map(({ executable }) => executable)).toEqual(["paplay"]);

    const primary = new FakeChild();
    const fallback = new FakeChild();
    const duringLogical: { value: SchedulerChild | undefined } = { value: undefined };
    const duringSpawn: SpawnPlayer = (executable) => {
      if (executable === "paplay") return primary;
      duringLogical.value?.kill();
      return fallback;
    };
    duringLogical.value = selectPlatformPlayer("linux", duringSpawn)?.(cue("/tmp/cue.wav"));
    primary.emit("error", enoent());
    expect(fallback.kill).toHaveBeenCalledOnce();
    expect(fallback.listenerCount("error")).toBe(0);

    const queued = spawnHarness();
    const queuedLogical = selectPlatformPlayer("linux", queued.spawnPlayer)?.(cue("/tmp/cue.wav"));
    const events: string[] = [];
    queuedLogical?.on("spawn", () => events.push("spawn"));
    childAt(queued.children, 0).emit("spawn");
    queuedLogical?.kill();
    await flushLifecycle();
    expect(events).toEqual([]);
  });

  it("lets AudioScheduler attach before synchronous duplicate lifecycle is delivered", async () => {
    const direct = new FakeChild();
    emitDuringRegistration(direct, "spawn", (listener) => {
      listener();
      listener();
    });
    emitDuringRegistration(direct, "close", (listener) => {
      listener(0, null);
      listener(1, null);
    });
    const launcher = selectPlatformPlayer("linux", () => direct);
    if (launcher === null) throw new Error("Linux launcher unavailable");
    const setTimeout = vi.fn(() => 1);
    const scheduler = new AudioScheduler({
      clock: { now: () => 0 },
      timers: { setTimeout, clearTimeout: () => undefined },
      isEventEnabled: () => true,
      resolveEligibility: () =>
        Promise.resolve({
          launchable: true,
          event: "appStart",
          priority: 1,
          theme: "core",
          wavPath: "/tmp/cue.wav",
          wavDurationMs: 1,
        }),
      launchPlayer: launcher,
    });

    await scheduler.request("appStart");
    await flushLifecycle();
    expect(scheduler.trackedChildCount).toBe(0);
    expect(setTimeout).toHaveBeenCalledOnce();
    expect(direct.listenerCount("error")).toBe(0);
    expect(direct.listenerCount("spawn")).toBe(0);
    expect(direct.listenerCount("close")).toBe(0);
  });
});
