import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { release } from "node:os";

import type { AudioEvent } from "./audio-catalog.js";
import { ConfigurationStore } from "./config.js";
import { resolveAudioEligibility } from "./eligibility.js";
import { selectPlatformPlayer, type PlayerLauncher } from "./platform-adapters.js";
import { AudioScheduler, type SchedulerClock, type SchedulerTimers } from "./scheduler.js";
import { TerminalOutcomeRequestAdapter } from "./terminal-outcomes.js";

export * from "./config.js";
export * from "./audio-catalog.js";
export * from "./eligibility.js";
export * from "./scheduler.js";
export * from "./platform-adapters.js";
export * from "./terminal-outcomes.js";

/** The exact raw terminal sequence for a literal physical Escape key. */
export const LITERAL_ESCAPE_SEQUENCE = "\u001b";

export interface AudioFeedbackRuntimeOptions {
  readonly agentDirectory?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly operatingSystemRelease?: string;
  readonly moduleUrl?: string;
  readonly clock?: SchedulerClock;
  readonly timers?: SchedulerTimers;
  readonly launchPlayer?: PlayerLauncher;
}

const systemClock: SchedulerClock = { now: Date.now };
const systemTimers: SchedulerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    // Every handle comes from the paired setTimeout implementation above.
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

function ignoreExpectedFailure(operation: Promise<unknown>): void {
  void operation.catch(() => {
    // Lifecycle audio is automatic and expected filesystem/process failures are silent.
  });
}

class AudioSessionRuntime {
  readonly #scheduler: AudioScheduler;
  readonly #terminalOutcomes: TerminalOutcomeRequestAdapter;
  #removeTerminalInputListener: (() => void) | null = null;
  #shutdown = false;

  constructor(scheduler: AudioScheduler) {
    this.#scheduler = scheduler;
    this.#terminalOutcomes = new TerminalOutcomeRequestAdapter(scheduler);
  }

  installTerminalInputListener(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui" || this.#shutdown) return;
    try {
      const remove = ctx.ui.onTerminalInput((data: string) => {
        if (data === LITERAL_ESCAPE_SEQUENCE) this.#terminalOutcomes.onLiteralEscape();
        // Returning undefined keeps this listener additive and never consumes or rewrites input.
        return undefined;
      });
      this.#removeTerminalInputListener = remove;
    } catch {
      // Raw input is best effort and unavailable outside compatible local TUI contexts.
    }
  }

  request(event: AudioEvent): Promise<unknown> {
    return this.#scheduler.request(event);
  }

  onAgentStart(): Promise<unknown> {
    return this.#terminalOutcomes.onAgentStart();
  }

  onAgentEnd(messages: unknown): void {
    this.#terminalOutcomes.onAgentEnd(messages);
  }

  onAgentSettled(): Promise<unknown> {
    return this.#terminalOutcomes.onAgentSettled();
  }

  shutdown(): void {
    if (this.#shutdown) return;
    this.#shutdown = true;
    const remove = this.#removeTerminalInputListener;
    this.#removeTerminalInputListener = null;
    if (remove !== null) {
      try {
        remove();
      } catch {
        // Pi may already have removed its terminal listeners during teardown.
      }
    }
    this.#terminalOutcomes.shutdown();
    this.#scheduler.shutdown();
  }
}

function createSessionRuntime(
  ctx: ExtensionContext,
  configuration: ConfigurationStore,
  options: AudioFeedbackRuntimeOptions,
): AudioSessionRuntime {
  const platform = options.platform ?? process.platform;
  const launchPlayer = options.launchPlayer ?? selectPlatformPlayer(platform);
  const scheduler = new AudioScheduler({
    clock: options.clock ?? systemClock,
    timers: options.timers ?? systemTimers,
    isEventEnabled: (event) => configuration.current.configuration.events[event],
    resolveEligibility: (request) =>
      resolveAudioEligibility(request, {
        getCurrentConfiguration: () => configuration.current.configuration,
        mode: ctx.mode,
        environment: options.environment ?? process.env,
        platform,
        operatingSystemRelease: options.operatingSystemRelease ?? release(),
        moduleUrl: options.moduleUrl ?? import.meta.url,
      }),
    // Eligibility rejects unsupported platforms before this process boundary is reached.
    launchPlayer: (cue) => {
      if (launchPlayer === null) throw new Error("Unsupported audio platform");
      return launchPlayer(cue);
    },
  });
  return new AudioSessionRuntime(scheduler);
}

/** Register Pi hooks while retaining exactly one runtime for the currently active session. */
export function registerAudioFeedbackExtension(
  pi: ExtensionAPI,
  options: AudioFeedbackRuntimeOptions = {},
): void {
  const agentDirectory = options.agentDirectory ?? getAgentDir();
  let runtime: AudioSessionRuntime | null = null;
  let sessionGeneration = 0;

  pi.on("session_start", async (event, ctx) => {
    const generation = ++sessionGeneration;
    runtime?.shutdown();
    runtime = null;

    const configuration = new ConfigurationStore({ agentDirectory });
    try {
      await configuration.load();
      if (generation !== sessionGeneration) return;
      const nextRuntime = createSessionRuntime(ctx, configuration, options);
      runtime = nextRuntime;
      nextRuntime.installTerminalInputListener(ctx);
      if (event.reason === "startup") await nextRuntime.request("appStart");
    } catch {
      // A failed session load or unexpected hook boundary leaves this session silently disabled.
    }
  });

  pi.on("agent_start", () => {
    if (runtime !== null) ignoreExpectedFailure(runtime.onAgentStart());
  });

  pi.on("tool_execution_end", (event) => {
    if (event.isError && runtime !== null) ignoreExpectedFailure(runtime.request("toolError"));
  });

  pi.on("agent_end", (event) => {
    try {
      runtime?.onAgentEnd(event.messages);
    } catch {
      // External message shapes are untrusted and never fail Pi's handler.
    }
  });

  pi.on("agent_settled", () => {
    if (runtime !== null) ignoreExpectedFailure(runtime.onAgentSettled());
  });

  pi.on("session_shutdown", () => {
    sessionGeneration += 1;
    const current = runtime;
    runtime = null;
    try {
      current?.shutdown();
    } catch {
      // Shutdown remains idempotent even if an injected resource behaves unexpectedly.
    }
  });
}

/** Pi extension factory; issue #8 will add its state-free command registration here. */
export default function audioFeedbackExtension(pi: ExtensionAPI): void {
  registerAudioFeedbackExtension(pi);
}
