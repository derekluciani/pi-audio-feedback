import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";

import type { LaunchableAudioCue } from "./eligibility.js";
import type { SchedulerChild } from "./scheduler.js";

export type PlayerPlatform = "darwin" | "linux" | "win32";

export type SpawnPlayer = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => SchedulerChild;

export type PlayerLauncher = (cue: LaunchableAudioCue) => SchedulerChild;

function spawnOptions(wavPath: string): SpawnOptions {
  return {
    cwd: dirname(wavPath),
    env: process.env,
    stdio: "ignore",
    detached: false,
    windowsHide: true,
    shell: false,
  };
}

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return error.code;
}

interface DirectChildListeners {
  readonly spawn: () => void;
  readonly error: (error: Error) => void;
  readonly close: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * Presents Linux primary/fallback attempts as one scheduler child. The primary's ENOENT is hidden,
 * and only the aplay attempt becomes the scheduler-visible lifecycle in that case.
 */
class LinuxFallbackChild extends EventEmitter implements SchedulerChild {
  readonly #wavPath: string;
  readonly #spawnPlayer: SpawnPlayer;
  #active: SchedulerChild | null = null;
  #activeListeners: DirectChildListeners | null = null;
  #spawned = false;
  #settled = false;
  #killed = false;

  constructor(wavPath: string, spawnPlayer: SpawnPlayer) {
    super();
    this.#wavPath = wavPath;
    this.#spawnPlayer = spawnPlayer;
    this.#launchPrimary();
  }

  kill(): boolean {
    this.#killed = true;
    const active = this.#active;
    if (active === null) return false;
    try {
      return active.kill();
    } catch {
      return false;
    }
  }

  #launchPrimary(): void {
    try {
      this.#attach(this.#spawnPlayer("paplay", [this.#wavPath], spawnOptions(this.#wavPath)), true);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      this.#launchFallback();
    }
  }

  #launchFallback(): void {
    this.#attach(this.#spawnPlayer("aplay", [this.#wavPath], spawnOptions(this.#wavPath)), false);
  }

  #attach(child: SchedulerChild, primary: boolean): void {
    this.#active = child;
    this.#spawned = false;
    const listeners: DirectChildListeners = {
      spawn: () => {
        if (this.#settled || child !== this.#active) return;
        this.#spawned = true;
        this.emit("spawn");
      },
      error: (error) => {
        if (this.#settled || child !== this.#active) return;
        if (primary && !this.#spawned && errorCode(error) === "ENOENT" && !this.#killed) {
          this.#detachActive();
          try {
            this.#launchFallback();
          } catch (fallbackError) {
            this.#finishWithError(fallbackError);
          }
          return;
        }
        this.#finishWithError(error);
      },
      close: (code, signal) => {
        if (this.#settled || child !== this.#active) return;
        this.#settled = true;
        this.#detachActive();
        if (!this.#killed) this.emit("close", code, signal);
      },
    };
    this.#activeListeners = listeners;
    child.on("error", listeners.error);
    child.on("spawn", listeners.spawn);
    child.on("close", listeners.close);
  }

  #finishWithError(error: unknown): void {
    this.#settled = true;
    this.#detachActive();
    if (!this.#killed) {
      this.emit("error", error instanceof Error ? error : new Error("Player launch failed"));
    }
  }

  #detachActive(): void {
    const child = this.#active;
    const listeners = this.#activeListeners;
    if (child !== null && listeners !== null) {
      child.removeListener("spawn", listeners.spawn);
      child.removeListener("error", listeners.error);
      child.removeListener("close", listeners.close);
    }
    this.#active = null;
    this.#activeListeners = null;
  }
}

/** Select a spawn-only adapter. Unsupported platforms intentionally have no launcher. */
export function selectPlatformPlayer(
  platform: string = process.platform,
  spawnPlayer: SpawnPlayer = nodeSpawn,
): PlayerLauncher | null {
  if (platform === "darwin") {
    return (cue) => spawnPlayer("afplay", [cue.wavPath], spawnOptions(cue.wavPath));
  }
  if (platform === "linux") {
    return (cue) => new LinuxFallbackChild(cue.wavPath, spawnPlayer);
  }
  if (platform === "win32") {
    return (cue) => {
      if (cue.powershellHelperPath === undefined) {
        throw new Error("Validated Windows PowerShell helper path is required");
      }
      return spawnPlayer(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          cue.powershellHelperPath,
          "-Path",
          cue.wavPath,
        ],
        spawnOptions(cue.wavPath),
      );
    };
  }
  return null;
}
