import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { LaunchableAudioCue } from "../extensions/eligibility.js";
import { selectPlatformPlayer, type SpawnPlayer } from "../extensions/platform-adapters.js";
import type { SchedulerChild } from "../extensions/scheduler.js";

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
  it("falls back exactly once after asynchronous pre-spawn paplay ENOENT", () => {
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

  it.each(["EACCES", "EPERM"])("does not fallback for pre-spawn %s", (code) => {
    const h = spawnHarness();
    const logical = selectPlatformPlayer("linux", h.spawnPlayer)?.(cue("/tmp/cue.wav"));
    const errors: Error[] = [];
    logical?.on("error", (error) => errors.push(error));
    childAt(h.children, 0).emit("error", Object.assign(new Error(code), { code }));
    childAt(h.children, 0).emit("close", 1, null);
    expect(h.calls.map(({ executable }) => executable)).toEqual(["paplay"]);
    expect(errors).toHaveLength(1);
  });

  it("never falls back after spawn, child error, or nonzero close and settles once", () => {
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
});
