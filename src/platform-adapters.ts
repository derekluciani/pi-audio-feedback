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
  spawnInstalled: boolean;
  errorInstalled: boolean;
  closeInstalled: boolean;
}

type LogicalTerminal =
  | { readonly type: "error"; readonly error: Error }
  | {
      readonly type: "close";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

/**
 * Presents Linux primary/fallback attempts as one scheduler child. Direct-child events are queued
 * to a microtask so the scheduler can attach immediately after the launcher returns. The primary's
 * pre-spawn ENOENT lifecycle is hidden and only the fallback becomes scheduler-visible.
 */
class LinuxFallbackChild extends EventEmitter implements SchedulerChild {
  readonly #wavPath: string;
  readonly #spawnPlayer: SpawnPlayer;
  #active: SchedulerChild | null = null;
  #activeListeners: DirectChildListeners | null = null;
  #directSpawned = false;
  #logicalSpawnQueued = false;
  #logicalSpawnDelivered = false;
  #terminal: LogicalTerminal | null = null;
  #terminalDelivered = false;
  #deliveryQueued = false;
  #killed = false;

  constructor(wavPath: string, spawnPlayer: SpawnPlayer) {
    super();
    this.#wavPath = wavPath;
    this.#spawnPlayer = spawnPlayer;
    this.#launchPrimary();
  }

  kill(): boolean {
    if (this.#killed) return false;
    this.#killed = true;
    this.#logicalSpawnQueued = false;
    const active = this.#active;
    this.#detachActive();
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
    if (this.#killed) return;
    this.#attach(this.#spawnPlayer("aplay", [this.#wavPath], spawnOptions(this.#wavPath)), false);
  }

  #attach(child: SchedulerChild, primary: boolean): void {
    if (this.#killed || this.#terminal !== null) {
      try {
        child.kill();
      } catch {
        // Reentrant termination is best effort.
      }
      return;
    }

    this.#active = child;
    this.#directSpawned = false;
    const listeners: DirectChildListeners = {
      spawn: () => {
        if (this.#terminal !== null || child !== this.#active || this.#directSpawned) return;
        this.#directSpawned = true;
        if (!this.#logicalSpawnQueued && !this.#logicalSpawnDelivered) {
          this.#logicalSpawnQueued = true;
          this.#queueDelivery();
        }
      },
      error: (error) => {
        if (this.#terminal !== null || child !== this.#active) return;
        if (primary && !this.#directSpawned && errorCode(error) === "ENOENT" && !this.#killed) {
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
        if (this.#terminal !== null || child !== this.#active) return;
        this.#terminal = { type: "close", code, signal };
        this.#detachActive();
        this.#queueDelivery();
      },
      spawnInstalled: false,
      errorInstalled: false,
      closeInstalled: false,
    };
    this.#activeListeners = listeners;

    listeners.errorInstalled = true;
    child.on("error", listeners.error);
    if (!this.#canListenTo(child)) {
      this.#detach(child, listeners);
      return;
    }
    listeners.spawnInstalled = true;
    child.on("spawn", listeners.spawn);
    if (!this.#canListenTo(child)) {
      this.#detach(child, listeners);
      return;
    }
    listeners.closeInstalled = true;
    child.on("close", listeners.close);
    if (!this.#canListenTo(child)) this.#detach(child, listeners);
  }

  #finishWithError(error: unknown): void {
    if (this.#terminal !== null) return;
    this.#terminal = {
      type: "error",
      error: error instanceof Error ? error : new Error("Player launch failed"),
    };
    this.#detachActive();
    this.#queueDelivery();
  }

  #queueDelivery(): void {
    if (this.#deliveryQueued) return;
    this.#deliveryQueued = true;
    queueMicrotask(() => {
      this.#deliveryQueued = false;
      if (this.#killed) return;
      if (this.#logicalSpawnQueued && !this.#logicalSpawnDelivered) {
        this.#logicalSpawnQueued = false;
        this.#logicalSpawnDelivered = true;
        this.emit("spawn");
      }
      const terminal = this.#terminal;
      if (this.#deliveryWasKilled() || terminal === null || this.#terminalDelivered) return;
      // Retain the terminal state permanently; marking it delivered prevents all reentrant and late
      // direct-child events from creating a second logical terminal.
      this.#terminalDelivered = true;
      if (terminal.type === "error") {
        // EventEmitter throws an unhandled `error`; contain it when no scheduler/caller subscribed.
        if (this.listenerCount("error") > 0) this.emit("error", terminal.error);
      } else {
        this.emit("close", terminal.code, terminal.signal);
      }
    });
  }

  #deliveryWasKilled(): boolean {
    return this.#killed;
  }

  #canListenTo(child: SchedulerChild): boolean {
    return child === this.#active && this.#terminal === null && !this.#killed;
  }

  #detachActive(): void {
    const child = this.#active;
    const listeners = this.#activeListeners;
    if (child !== null && listeners !== null) this.#detach(child, listeners);
    if (child === this.#active) {
      this.#active = null;
      this.#activeListeners = null;
    }
  }

  #detach(child: SchedulerChild, listeners: DirectChildListeners): void {
    if (listeners.spawnInstalled) child.removeListener("spawn", listeners.spawn);
    if (listeners.errorInstalled) child.removeListener("error", listeners.error);
    if (listeners.closeInstalled) child.removeListener("close", listeners.close);
    // Keep attempted-registration flags set. A hostile child may invoke a callback before `on()`
    // actually records it; the post-registration detach must then remove that late-added listener.
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
