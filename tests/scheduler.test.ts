import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { AUDIO_EVENTS, type AudioEvent, type AudioTheme } from "../extensions/audio-catalog.js";
import { DEFAULT_CONFIGURATION, type AudioFeedbackConfiguration } from "../extensions/config.js";
import { acceptSettingsToggleOffRequest } from "../extensions/eligibility.js";
import {
  AudioScheduler,
  MAX_WAV_DURATION_MS,
  readPcmWavDurationMs,
  type AudioSchedulerOptions,
  type SchedulerChild,
} from "../extensions/scheduler.js";
import { TerminalOutcomeRequestAdapter } from "../extensions/terminal-outcomes.js";

class FakeChild extends EventEmitter implements SchedulerChild {
  readonly kill = vi.fn(() => true);
}

interface Harness {
  now: { value: number };
  enabled: Record<AudioEvent, boolean>;
  theme: { value: AudioTheme };
  requests: string[];
  starts: string[];
  children: FakeChild[];
  notices: string[];
  timerDelays: number[];
  activeTimerCount(): number;
  fireTimer(index?: number): void;
  scheduler: AudioScheduler;
}

function makeHarness(overrides: Partial<AudioSchedulerOptions> = {}): Harness {
  const now = { value: 0 };
  const enabled = Object.fromEntries(AUDIO_EVENTS.map((event) => [event, true])) as Record<
    AudioEvent,
    boolean
  >;
  const theme = { value: "core" as AudioTheme };
  const requests: string[] = [];
  const starts: string[] = [];
  const children: FakeChild[] = [];
  const notices: string[] = [];
  const timerDelays: number[] = [];
  const timerCallbacks = new Map<number, () => void>();
  let nextTimer = 0;

  const scheduler = new AudioScheduler({
    clock: { now: () => now.value },
    timers: {
      setTimeout: (callback, delay) => {
        const id = nextTimer++;
        timerCallbacks.set(id, callback);
        timerDelays.push(delay);
        return id;
      },
      clearTimeout: (handle) => timerCallbacks.delete(Number(handle)),
    },
    isEventEnabled: (event) => enabled[event],
    resolveEligibility: (request) => {
      const record = request as Readonly<Record<string, unknown>>;
      const event = record.event as AudioEvent;
      const selectedTheme = (record.themeOverride as AudioTheme | undefined) ?? theme.value;
      requests.push(`${event}:${selectedTheme}`);
      if (!enabled[event] && record.togglePolicy !== "accepted") {
        return Promise.resolve({ launchable: false as const, reason: "disabled" as const });
      }
      return Promise.resolve({
        launchable: true as const,
        event,
        priority: 1,
        theme: selectedTheme,
        wavPath: `/audio/${selectedTheme}/${event}.wav`,
        wavDurationMs: 25,
      });
    },
    launchPlayer: (cue) => {
      starts.push(`${cue.event}:${cue.theme}`);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    onPreviewFailure: ({ stage }) => notices.push(stage),
    ...overrides,
  });

  return {
    now,
    enabled,
    theme,
    requests,
    starts,
    children,
    notices,
    timerDelays,
    activeTimerCount: () => timerCallbacks.size,
    fireTimer: (index = 0) => timerCallbacks.get(index)?.(),
    scheduler,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function childAt(harness: Harness, index: number): FakeChild {
  const child = harness.children[index];
  if (child === undefined) throw new Error(`Missing child at index ${String(index)}`);
  return child;
}

function close(child: FakeChild, code = 0): void {
  child.emit("close", code, null);
}

describe("scheduler sequences and priorities", () => {
  it("runs a normal zero-tool prompt as agentStart then agentSettled", async () => {
    const h = makeHarness();
    await h.scheduler.request("agentStart");
    await h.scheduler.request("agentSettled");
    expect(h.starts).toEqual(["agentStart:core"]);
    close(childAt(h, 0));
    await settle();
    expect(h.requests).toEqual(["agentStart:core", "agentSettled:core"]);
    expect(h.starts).toEqual(["agentStart:core", "agentSettled:core"]);
  });

  it("implements every PRD 6.4 queue row and retains older equal priority", async () => {
    const h = makeHarness();
    await h.scheduler.request("settingsNavigate");
    await h.scheduler.request("settingsRootExit");
    expect(h.scheduler.pendingEvent).toBe("settingsRootExit");
    await h.scheduler.request("settingsOptionSelect");
    expect(h.scheduler.pendingEvent).toBe("settingsRootExit");
    await h.scheduler.request("toolError");
    expect(h.scheduler.pendingEvent).toBe("toolError");
    await h.scheduler.request("toolError");
    expect(h.scheduler.pendingEvent).toBe("toolError");
    await h.scheduler.request("agentSettled");
    expect(h.scheduler.pendingEvent).toBe("agentSettled");
    await h.scheduler.request("agentAborted");
    expect(h.scheduler.pendingEvent).toBe("agentSettled");
    close(childAt(h, 0));
    await settle();
    expect(h.starts).toEqual(["settingsNavigate:core", "agentSettled:core"]);
  });

  it("replaces pending navigation or tool error with completion without killing playback", async () => {
    for (const pending of ["settingsNavigate", "toolError"] as const) {
      const h = makeHarness();
      await h.scheduler.request("appStart");
      await h.scheduler.request(pending);
      await h.scheduler.request("agentSettled");
      expect(childAt(h, 0).kill).not.toHaveBeenCalled();
      close(childAt(h, 0));
      await settle();
      expect(h.starts).toEqual(["appStart:core", "agentSettled:core"]);
    }
  });
});

describe("debounce, expiry, and launch-time exceptions", () => {
  it("coalesces 0/999 and opens a new tool-error window at exactly 1000ms", async () => {
    const h = makeHarness();
    expect(await h.scheduler.request("toolError")).toBe("accepted");
    h.now.value = 999;
    expect(await h.scheduler.request("toolError")).toBe("coalesced");
    h.now.value = 1_000;
    expect(await h.scheduler.request("toolError")).toBe("accepted");
    close(childAt(h, 0));
    await settle();
    expect(h.starts).toEqual(["toolError:core", "toolError:core"]);
  });

  it("disabled errors neither open nor extend the debounce window", async () => {
    const h = makeHarness();
    h.enabled.toolError = false;
    expect(await h.scheduler.request("toolError")).toBe("discarded");
    h.now.value = 999;
    h.enabled.toolError = true;
    expect(await h.scheduler.request("toolError")).toBe("accepted");
    h.now.value = 1_500;
    h.enabled.toolError = false;
    expect(await h.scheduler.request("toolError")).toBe("discarded");
    h.now.value = 1_999;
    h.enabled.toolError = true;
    expect(await h.scheduler.request("toolError")).toBe("accepted");
  });

  it("purges ordinary pending at the exact 2000ms comparison boundary", async () => {
    const beforeBoundary = makeHarness();
    await beforeBoundary.scheduler.request("appStart");
    await beforeBoundary.scheduler.request("agentAborted");
    beforeBoundary.now.value = 1_999;
    expect(await beforeBoundary.scheduler.request("settingsNavigate")).toBe("discarded");
    expect(beforeBoundary.scheduler.pendingEvent).toBe("agentAborted");

    const atBoundary = makeHarness();
    await atBoundary.scheduler.request("appStart");
    await atBoundary.scheduler.request("agentAborted");
    atBoundary.now.value = 2_000;
    expect(await atBoundary.scheduler.request("settingsNavigate")).toBe("accepted");
    expect(atBoundary.scheduler.pendingEvent).toBe("settingsNavigate");
    close(childAt(atBoundary, 0));
    await settle();
    expect(atBoundary.starts).toEqual(["appStart:core", "settingsNavigate:core"]);

    const completion = makeHarness();
    await completion.scheduler.request("appStart");
    await completion.scheduler.request("agentSettled");
    completion.now.value = 100_000;
    close(childAt(completion, 0));
    await settle();
    expect(completion.starts).toEqual(["appStart:core", "agentSettled:core"]);
  });

  it("uses current config/theme at launch and retains a validated preview candidate", async () => {
    const h = makeHarness();
    await h.scheduler.request("appStart");
    await h.scheduler.request("agentStart");
    h.theme.value = "soft";
    close(childAt(h, 0));
    await settle();
    expect(h.starts).toEqual(["appStart:core", "agentStart:soft"]);

    close(childAt(h, 1));
    await h.scheduler.request("settingsNavigate");
    await h.scheduler.request("agentStart");
    h.enabled.agentStart = false;
    close(childAt(h, 2));
    await settle();
    expect(h.starts).toEqual(["appStart:core", "agentStart:soft", "settingsNavigate:soft"]);

    await h.scheduler.request("settingsThemePreview", { themeOverride: "organic" });
    h.theme.value = "core";
    close(childAt(h, 3));
    await settle();
    expect(h.starts.at(-1)).toBe("settingsThemePreview:organic");
    expect(await h.scheduler.request("appStart", { themeOverride: "soft" })).toBe("invalid");
  });

  it("requires the opaque accepted proof and survives disabling all toggles", async () => {
    const h = makeHarness();
    await h.scheduler.request("appStart");
    const configuration = (): AudioFeedbackConfiguration => ({
      ...DEFAULT_CONFIGURATION,
      events: { ...h.enabled },
    });
    const proof = acceptSettingsToggleOffRequest(configuration);
    expect(proof).not.toBeNull();
    if (proof === null) throw new Error("Expected accepted proof");
    expect(await h.scheduler.request(proof)).toBe("accepted");
    for (const event of AUDIO_EVENTS) h.enabled[event] = false;
    close(childAt(h, 0));
    await settle();
    expect(h.starts).toEqual(["appStart:core", "settingsToggleOff:core"]);
    expect(
      await h.scheduler.request({ event: "settingsToggleOff", togglePolicy: "accepted" }),
    ).toBe("invalid");
  });
});

describe("child lifecycle, preview notices, watchdog, and shutdown", () => {
  it("removes a child on the first error/close and continues after launch failure", async () => {
    let launchCount = 0;
    const h = makeHarness({
      launchPlayer: () => {
        launchCount += 1;
        if (launchCount === 1) throw new Error("spawn throw");
        const child = new FakeChild();
        h.children.push(child);
        h.starts.push("agentSettled:core");
        return child;
      },
    });
    const first = h.scheduler.request("appStart");
    await h.scheduler.request("agentSettled");
    await first;
    await settle();
    expect(h.starts).toEqual(["agentSettled:core"]);
    expect(h.notices).toEqual([]);
    expect(h.scheduler.trackedChildCount).toBe(1);
    close(childAt(h, 0), 7);
    expect(h.scheduler.trackedChildCount).toBe(0);
  });

  it("notices only approved preview pre-spawn failures and stays silent post-spawn", async () => {
    for (const reason of ["missing-wav", "missing-helper"] as const) {
      const validation = makeHarness({
        resolveEligibility: () => Promise.resolve({ launchable: false, reason }),
      });
      await validation.scheduler.request("settingsThemePreview", { themeOverride: "soft" });
      expect(validation.notices).toEqual(["validation"]);
    }

    for (const reason of [
      "invalid-request",
      "invalid-event",
      "invalid-theme-override",
      "invalid-toggle-policy",
      "invalid-configuration",
      "non-tui",
      "ci",
      "ssh",
      "unsupported-platform",
      "disabled",
      "missing-mapping",
    ] as const) {
      const suppression = makeHarness({
        resolveEligibility: () => Promise.resolve({ launchable: false, reason }),
      });
      await suppression.scheduler.request("settingsThemePreview", { themeOverride: "soft" });
      expect(suppression.notices, reason).toEqual([]);
    }

    const automatic = makeHarness({
      resolveEligibility: () => Promise.resolve({ launchable: false, reason: "missing-wav" }),
    });
    await automatic.scheduler.request("agentStart");
    expect(automatic.notices).toEqual([]);

    const rejected = makeHarness({
      resolveEligibility: () => Promise.reject(new Error("invalid resolver input")),
    });
    await rejected.scheduler.request("settingsThemePreview", { themeOverride: "soft" });
    expect(rejected.notices).toEqual([]);

    const preSpawn = makeHarness();
    await preSpawn.scheduler.request("settingsThemePreview", { themeOverride: "soft" });
    childAt(preSpawn, 0).emit("error", new Error("ENOENT"));
    await settle();
    expect(preSpawn.notices).toEqual(["pre-spawn-error"]);

    const postSpawn = makeHarness();
    await postSpawn.scheduler.request("settingsThemePreview", { themeOverride: "soft" });
    childAt(postSpawn, 0).emit("spawn");
    close(childAt(postSpawn, 0), 1);
    expect(postSpawn.notices).toEqual([]);
  });

  it("kills an untracked child returned after reentrant shutdown", async () => {
    const child = new FakeChild();
    const holder: { scheduler: AudioScheduler | null } = { scheduler: null };
    const h = makeHarness({
      launchPlayer: () => {
        holder.scheduler?.shutdown();
        return child;
      },
    });
    const scheduler = h.scheduler;
    holder.scheduler = scheduler;
    await scheduler.request("appStart");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.eventNames()).toEqual([]);
    expect(scheduler.trackedChildCount).toBe(0);
    expect(h.activeTimerCount()).toBe(0);
  });

  it("cleans and kills when shutdown reenters during listener registration", async () => {
    const holder: { scheduler: AudioScheduler | null } = { scheduler: null };
    class ShutdownRegistrationChild extends FakeChild {
      override on(event: "spawn", listener: () => void): this;
      override on(event: "error", listener: (error: Error) => void): this;
      override on(
        event: "close",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ): this;
      override on(event: string, listener: Parameters<EventEmitter["on"]>[1]): this {
        super.on(event, listener);
        holder.scheduler?.shutdown();
        return this;
      }
    }

    const child = new ShutdownRegistrationChild();
    const h = makeHarness({ launchPlayer: () => child });
    holder.scheduler = h.scheduler;
    await h.scheduler.request("appStart");
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.eventNames()).toEqual([]);
    expect(h.scheduler.trackedChildCount).toBe(0);
    expect(h.activeTimerCount()).toBe(0);
  });

  it("incrementally cleans synchronous listener settlement and event orderings", async () => {
    class RegistrationChild extends FakeChild {
      readonly #during: (event: string, child: RegistrationChild) => void;

      constructor(during: (event: string, child: RegistrationChild) => void) {
        super();
        this.#during = during;
      }

      override on(event: "spawn", listener: () => void): this;
      override on(event: "error", listener: (error: Error) => void): this;
      override on(
        event: "close",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ): this;
      override on(event: string, listener: Parameters<EventEmitter["on"]>[1]): this {
        super.on(event, listener);
        this.#during(event, this);
        return this;
      }
    }

    const scenarios: Array<(event: string, child: RegistrationChild) => void> = [
      (event, child) => {
        if (event === "error") {
          child.emit("error", new Error("sync"));
          child.emit("close", 1, null);
        }
      },
      (event, child) => {
        if (event === "spawn") {
          child.emit("spawn");
          child.emit("error", new Error("after spawn"));
        }
      },
      (event, child) => {
        if (event === "close") child.emit("close", 0, null);
      },
    ];

    for (const during of scenarios) {
      const child = new RegistrationChild(during);
      const h = makeHarness({ launchPlayer: () => child });
      await h.scheduler.request("settingsThemePreview", { themeOverride: "soft" });
      expect(child.eventNames()).toEqual([]);
      expect(h.scheduler.trackedChildCount).toBe(0);
      expect(h.activeTimerCount()).toBe(0);
    }
  });

  it("arms duration+2000 watchdog, kills only the running child, and starts pending", async () => {
    const h = makeHarness();
    await h.scheduler.request("appStart");
    await h.scheduler.request("agentSettled");
    childAt(h, 0).emit("spawn");
    expect(h.timerDelays).toEqual([2_025]);
    h.fireTimer();
    await settle();
    expect(childAt(h, 0).kill).toHaveBeenCalledOnce();
    expect(childAt(h, 0).eventNames()).toEqual([]);
    expect(h.activeTimerCount()).toBe(0);
    expect(h.starts).toEqual(["appStart:core", "agentSettled:core"]);
  });

  it("clears a normal watchdog and shutdown is idempotent and launch-proof", async () => {
    const h = makeHarness();
    await h.scheduler.request("appStart");
    childAt(h, 0).emit("spawn");
    await h.scheduler.request("agentSettled");
    close(childAt(h, 0));
    h.scheduler.shutdown();
    h.scheduler.shutdown();
    h.fireTimer();
    expect(childAt(h, 0).kill).not.toHaveBeenCalled();
    expect(await h.scheduler.request("appStart")).toBe("shutdown");
    expect(h.starts).toEqual(["appStart:core"]);
  });

  it("cleans active listeners and timers while ignoring shutdown kill failures", async () => {
    const h = makeHarness();
    await h.scheduler.request("appStart");
    const child = childAt(h, 0);
    child.emit("spawn");
    child.kill.mockImplementation(() => {
      throw new Error("gone");
    });
    expect(() => {
      h.scheduler.shutdown();
    }).not.toThrow();
    expect(child.eventNames()).toEqual([]);
    expect(h.activeTimerCount()).toBe(0);
    expect(h.scheduler.trackedChildCount).toBe(0);
  });
});

describe("production terminal-outcome request adapter", () => {
  function makeTerminalHarness(): {
    harness: Harness;
    adapter: TerminalOutcomeRequestAdapter;
    requestSequence: AudioEvent[];
  } {
    const harness = makeHarness();
    const requestSequence: AudioEvent[] = [];
    const adapter = new TerminalOutcomeRequestAdapter({
      request: async (event) => {
        requestSequence.push(event);
        return harness.scheduler.request(event);
      },
    });
    return { harness, adapter, requestSequence };
  }

  async function finishCurrent(harness: Harness): Promise<void> {
    const child = harness.children.at(-1);
    if (child === undefined) throw new Error("Expected current production scheduler child");
    close(child);
    await settle();
  }

  it("drives exact retry, auto-compaction, steering, follow-up, and final sequences", async () => {
    const { harness, adapter, requestSequence } = makeTerminalHarness();
    for (const boundary of ["initial", "retry", "auto-compaction", "steering", "follow-up"]) {
      await adapter.onAgentStart();
      expect(boundary).toBeTruthy();
      await finishCurrent(harness);
    }
    await adapter.onAgentSettled();
    expect(requestSequence).toEqual([
      "agentStart",
      "agentStart",
      "agentStart",
      "agentStart",
      "agentStart",
      "agentSettled",
    ]);
    expect(harness.starts).toEqual(requestSequence.map((event) => `${event}:core`));
  });

  it("ignores literal Escape while idle/settings and for non-aborted outcomes", async () => {
    const { harness, adapter, requestSequence } = makeTerminalHarness();
    adapter.onLiteralEscape();
    adapter.onLiteralEscape();
    await adapter.onAgentStart();
    adapter.onLiteralEscape();
    adapter.onAgentEnd([{ role: "assistant", stopReason: "stop" }]);
    await finishCurrent(harness);
    await adapter.onAgentSettled();
    expect(requestSequence).toEqual(["agentStart", "agentSettled"]);
    expect(harness.starts).toEqual(["agentStart:core", "agentSettled:core"]);
  });

  it("requests one abort and no completion only for literal-Escape confirmed abort", async () => {
    const { harness, adapter, requestSequence } = makeTerminalHarness();
    await adapter.onAgentStart();
    adapter.onLiteralEscape();
    adapter.onAgentEnd([
      { role: "assistant", stopReason: "stop" },
      { role: "assistant", stopReason: "aborted" },
    ]);
    await finishCurrent(harness);
    await adapter.onAgentSettled();
    expect(requestSequence).toEqual(["agentStart", "agentAborted"]);
    expect(harness.starts).toEqual(["agentStart:core", "agentAborted:core"]);
  });
});

describe("WAV duration validation", () => {
  it("parses a bounded PCM duration and rejects malformed headers", async () => {
    const path = join(tmpdir(), `scheduler-${String(process.pid)}-${String(Date.now())}.wav`);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "ascii");
    header.writeUInt32LE(48_036, 4);
    header.write("WAVEfmt ", 8, "ascii");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(48_000, 24);
    header.writeUInt32LE(96_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "ascii");
    header.writeUInt32LE(48_000, 40);
    await writeFile(path, header);
    await expect(readPcmWavDurationMs(path)).resolves.toBe(500);
    header.write("NOPE", 0, "ascii");
    await writeFile(path, header);
    await expect(readPcmWavDurationMs(path)).rejects.toThrow("Invalid packaged PCM WAV header");
    expect(MAX_WAV_DURATION_MS).toBe(60_000);
  });
});
