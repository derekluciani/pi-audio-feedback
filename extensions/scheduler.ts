import { open } from "node:fs/promises";

import {
  AUDIO_EVENT_PRIORITIES,
  isAudioEvent,
  isAudioTheme,
  type AudioEvent,
  type AudioTheme,
} from "./audio-catalog.js";
import {
  isAcceptedSettingsToggleOffRequest,
  type AcceptedSettingsToggleOffRequest,
  type AudioEligibilityResult,
  type LaunchableAudioCue,
} from "./eligibility.js";

export const PENDING_EXPIRY_MS = 2_000;
export const TOOL_ERROR_DEBOUNCE_MS = 1_000;
export const WATCHDOG_GRACE_MS = 2_000;
/** Prevent corrupt metadata from creating effectively permanent watchdogs. */
export const MAX_WAV_DURATION_MS = 60_000;

export interface SchedulerClock {
  now(): number;
}

export interface SchedulerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerChild {
  on(event: "spawn", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  removeListener(event: "spawn", listener: () => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
  removeListener(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(): boolean;
}

export interface AudioRequestOptions {
  readonly themeOverride?: AudioTheme;
  readonly togglePolicy?: "launch";
}

export interface ScheduledAudioRequest {
  readonly event: AudioEvent;
  readonly requestedAt: number;
  readonly priority: number;
  readonly eligibilityRequest: Readonly<Record<string, unknown>> | AcceptedSettingsToggleOffRequest;
}

export type SchedulerRequestResult =
  "accepted" | "coalesced" | "discarded" | "invalid" | "shutdown";

export interface PreviewFailure {
  readonly event: "settingsThemePreview";
  readonly stage: "validation" | "spawn-throw" | "pre-spawn-error";
}

export interface AudioSchedulerOptions {
  readonly clock: SchedulerClock;
  readonly timers: SchedulerTimers;
  /** Reads only the current in-memory toggle and must not snapshot other launch policy. */
  readonly isEventEnabled: (event: AudioEvent) => boolean;
  readonly resolveEligibility: (request: unknown) => Promise<AudioEligibilityResult>;
  readonly launchPlayer: (cue: LaunchableAudioCue) => SchedulerChild;
  readonly readWavDurationMs?: (wavPath: string) => Promise<number>;
  readonly onPreviewFailure?: (failure: PreviewFailure) => void;
}

interface PlayingRecord {
  child: SchedulerChild | null;
  spawned: boolean;
  settled: boolean;
  watchdog: unknown;
  removeListeners: (() => void) | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.some((candidate) => candidate === key));
}

function parseRequest(
  eventOrProof: unknown,
  options: unknown,
  requestedAt: number,
): ScheduledAudioRequest | null {
  if (isAcceptedSettingsToggleOffRequest(eventOrProof)) {
    if (!isRecord(options) || Object.keys(options).length !== 0) return null;
    return {
      event: "settingsToggleOff",
      requestedAt,
      priority: AUDIO_EVENT_PRIORITIES.settingsToggleOff,
      eligibilityRequest: eventOrProof,
    };
  }
  if (!isAudioEvent(eventOrProof) || !isRecord(options)) return null;
  if (!hasOnlyKeys(options, ["themeOverride", "togglePolicy"])) return null;
  if (options.togglePolicy !== undefined && options.togglePolicy !== "launch") return null;
  if (
    options.themeOverride !== undefined &&
    (eventOrProof !== "settingsThemePreview" || !isAudioTheme(options.themeOverride))
  ) {
    return null;
  }

  const eligibilityRequest = Object.freeze({
    event: eventOrProof,
    ...(options.themeOverride === undefined ? {} : { themeOverride: options.themeOverride }),
    ...(options.togglePolicy === undefined ? {} : { togglePolicy: options.togglePolicy }),
  });
  return {
    event: eventOrProof,
    requestedAt,
    priority: AUDIO_EVENT_PRIORITIES[eventOrProof],
    eligibilityRequest,
  };
}

function validDuration(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_WAV_DURATION_MS;
}

/** Read the duration from a bounded, canonical PCM WAV header without loading audio data. */
export async function readPcmWavDurationMs(wavPath: string): Promise<number> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(wavPath, "r");
    const header = Buffer.alloc(44);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (
      bytesRead !== header.length ||
      header.toString("ascii", 0, 4) !== "RIFF" ||
      header.toString("ascii", 8, 12) !== "WAVE" ||
      header.toString("ascii", 12, 16) !== "fmt " ||
      header.readUInt32LE(16) !== 16 ||
      header.readUInt16LE(20) !== 1 ||
      header.toString("ascii", 36, 40) !== "data"
    ) {
      throw new Error("Invalid packaged PCM WAV header");
    }
    const byteRate = header.readUInt32LE(28);
    const dataBytes = header.readUInt32LE(40);
    const durationMs = byteRate === 0 ? Number.NaN : (dataBytes / byteRate) * 1_000;
    if (!validDuration(durationMs)) throw new Error("Invalid packaged WAV duration");
    return durationMs;
  } finally {
    await handle?.close();
  }
}

/** Deterministic single-playing/single-pending scheduler and direct-child lifecycle owner. */
export class AudioScheduler {
  readonly #options: AudioSchedulerOptions;
  readonly #children = new Set<SchedulerChild>();
  #playing: PlayingRecord | null = null;
  #pending: ScheduledAudioRequest | null = null;
  #toolErrorWindowStart: number | null = null;
  #draining = false;
  #shutdown = false;

  constructor(options: AudioSchedulerOptions) {
    this.#options = options;
  }

  get isShutdown(): boolean {
    return this.#shutdown;
  }

  get trackedChildCount(): number {
    return this.#children.size;
  }

  get pendingEvent(): AudioEvent | null {
    return this.#pending?.event ?? null;
  }

  /** Narrow resource state used by assembled acceptance tests. */
  get hasActiveWatchdog(): boolean {
    return this.#playing?.watchdog !== null && this.#playing?.watchdog !== undefined;
  }

  async request(event: unknown, options: unknown = {}): Promise<SchedulerRequestResult> {
    if (this.#shutdown) return "shutdown";
    const now = this.#options.clock.now();
    const request = parseRequest(event, options, now);
    if (request === null) return "invalid";

    if (request.event === "toolError") {
      let enabled = false;
      try {
        enabled = this.#options.isEventEnabled("toolError");
      } catch {
        return "discarded";
      }
      if (!enabled) return "discarded";
      if (
        this.#toolErrorWindowStart !== null &&
        now - this.#toolErrorWindowStart < TOOL_ERROR_DEBOUNCE_MS
      ) {
        return "coalesced";
      }
      this.#toolErrorWindowStart = now;
    }

    this.#purgeExpiredPending(now);
    if (this.#playing === null && !this.#draining) {
      this.#pending = request;
      await this.#drainPending();
      return "accepted";
    }
    if (this.#pending === null || request.priority > this.#pending.priority) {
      this.#pending = request;
      return "accepted";
    }
    return "discarded";
  }

  /** Idempotently stop this scheduler. No child or filesystem operation is awaited. */
  shutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    this.#pending = null;
    const children = [...this.#children];
    const playing = this.#playing;
    this.#playing = null;
    if (playing !== null) this.#clearPlayingResources(playing);
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // Direct-child termination is explicitly best effort.
      }
    }
    this.#children.clear();
  }

  #purgeExpiredPending(now: number): void {
    if (
      this.#pending !== null &&
      this.#pending.event !== "agentSettled" &&
      now - this.#pending.requestedAt >= PENDING_EXPIRY_MS
    ) {
      this.#pending = null;
    }
  }

  async #drainPending(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (!this.#shutdown && this.#playing === null && this.#pending !== null) {
        const request = this.#pending;
        this.#pending = null;
        if (
          request.event !== "agentSettled" &&
          this.#options.clock.now() - request.requestedAt >= PENDING_EXPIRY_MS
        ) {
          continue;
        }
        await this.#tryLaunch(request);
      }
    } finally {
      this.#draining = false;
      if (!this.#shutdown && this.#playing === null && this.#pending !== null) {
        void this.#drainPending();
      }
    }
  }

  async #tryLaunch(request: ScheduledAudioRequest): Promise<void> {
    const record: PlayingRecord = {
      child: null,
      spawned: false,
      settled: false,
      watchdog: null,
      removeListeners: null,
    };
    this.#playing = record;

    let eligibility: AudioEligibilityResult;
    try {
      eligibility = await this.#options.resolveEligibility(request.eligibilityRequest);
    } catch {
      eligibility = { launchable: false, reason: "invalid-request" };
    }
    if (this.#shutdown || this.#playing !== record) return;
    if (!eligibility.launchable) {
      this.#playing = null;
      if (eligibility.reason === "missing-wav" || eligibility.reason === "missing-helper") {
        this.#notifyPreview(request, "validation");
      }
      return;
    }

    let durationMs: number;
    const suppliedDuration = eligibility.wavDurationMs;
    try {
      durationMs =
        suppliedDuration === undefined
          ? await (this.#options.readWavDurationMs ?? readPcmWavDurationMs)(eligibility.wavPath)
          : suppliedDuration;
    } catch {
      if (this.#playing === record) this.#playing = null;
      this.#notifyPreview(request, "validation");
      return;
    }
    if (!this.#canContinue(record)) return;
    if (!validDuration(durationMs)) {
      this.#playing = null;
      this.#notifyPreview(request, "validation");
      return;
    }

    let child: SchedulerChild;
    try {
      child = this.#options.launchPlayer(eligibility);
    } catch {
      if (this.#playing === record) this.#playing = null;
      this.#notifyPreview(request, "spawn-throw");
      return;
    }

    // launchPlayer is an injected process boundary and may reenter shutdown before returning.
    if (!this.#canContinue(record)) {
      this.#killChild(child);
      return;
    }
    record.child = child;
    this.#children.add(child);

    const installed = { error: false, spawn: false, close: false };
    const onSpawn = (): void => {
      if (record.settled || this.#playing !== record || record.spawned) return;
      record.spawned = true;
      const timerState = { firedSynchronously: false };
      const handle = this.#options.timers.setTimeout(() => {
        timerState.firedSynchronously = true;
        this.#settle(record, true);
      }, durationMs + WATCHDOG_GRACE_MS);
      if (timerState.firedSynchronously || !this.#canContinue(record)) {
        this.#options.timers.clearTimeout(handle);
      } else {
        record.watchdog = handle;
      }
    };
    const onError = (): void => {
      if (!record.spawned) this.#notifyPreview(request, "pre-spawn-error");
      this.#settle(record, false);
    };
    const onClose = (): void => {
      this.#settle(record, false);
    };
    const removeInstalledListeners = (): void => {
      if (installed.error) child.removeListener("error", onError);
      if (installed.spawn) child.removeListener("spawn", onSpawn);
      if (installed.close) child.removeListener("close", onClose);
      installed.error = false;
      installed.spawn = false;
      installed.close = false;
    };
    record.removeListeners = removeInstalledListeners;

    installed.error = true;
    child.on("error", onError);
    if (!this.#canContinue(record)) return;
    installed.spawn = true;
    child.on("spawn", onSpawn);
    if (!this.#canContinue(record)) return;
    installed.close = true;
    child.on("close", onClose);
    if (!this.#canContinue(record)) removeInstalledListeners();
  }

  #killChild(child: SchedulerChild): void {
    try {
      child.kill();
    } catch {
      // Direct-child termination is explicitly best effort.
    }
  }

  #canContinue(record: PlayingRecord): boolean {
    return !this.#shutdown && this.#playing === record;
  }

  #notifyPreview(request: ScheduledAudioRequest, stage: PreviewFailure["stage"]): void {
    if (request.event !== "settingsThemePreview") return;
    try {
      this.#options.onPreviewFailure?.({ event: "settingsThemePreview", stage });
    } catch {
      // A UI notice failure must not escape into Pi's event handler.
    }
  }

  #clearPlayingResources(record: PlayingRecord): void {
    if (record.watchdog !== null) {
      this.#options.timers.clearTimeout(record.watchdog);
      record.watchdog = null;
    }
    record.removeListeners?.();
    record.removeListeners = null;
    if (record.child !== null) this.#children.delete(record.child);
  }

  #settle(record: PlayingRecord, watchdogExpired: boolean): void {
    if (record.settled || this.#playing !== record) return;
    record.settled = true;
    this.#clearPlayingResources(record);
    this.#playing = null;
    if (watchdogExpired && record.child !== null) {
      try {
        record.child.kill();
      } catch {
        // Watchdog termination is best effort and never user-visible.
      }
    }
    void this.#drainPending();
  }
}
