import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { release } from "node:os";

import type { AudioEvent, AudioTheme } from "./audio-catalog.js";
import { ConfigurationStore, type ConfigurationFileSystem } from "./config.js";
import {
  acceptSettingsToggleOffRequest,
  resolveAudioEligibility,
  type AcceptedSettingsToggleOffRequest,
} from "./eligibility.js";
import { selectPlatformPlayer, type PlayerLauncher } from "./platform-adapters.js";
import {
  AudioScheduler,
  type PreviewFailure,
  type SchedulerClock,
  type SchedulerRequestResult,
  type SchedulerTimers,
} from "./scheduler.js";
import { AudioSettingsComponent, SettingsStateMachine } from "./settings.js";
import { TerminalOutcomeRequestAdapter } from "./terminal-outcomes.js";

export * from "./config.js";
export * from "./audio-catalog.js";
export * from "./eligibility.js";
export * from "./scheduler.js";
export * from "./platform-adapters.js";
export * from "./terminal-outcomes.js";
export * from "./settings.js";

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
  /** Injectable persistence boundary used by deterministic host integration tests. */
  readonly configurationFileSystem?: ConfigurationFileSystem;
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
  #previewFailureListener: ((failure: PreviewFailure) => void) | null = null;

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

  request(
    event: AudioEvent,
    options: { readonly themeOverride?: AudioTheme } = {},
  ): Promise<SchedulerRequestResult> {
    return this.#scheduler.request(event, options);
  }

  requestAcceptedToggleOff(
    proof: AcceptedSettingsToggleOffRequest,
  ): Promise<SchedulerRequestResult> {
    return this.#scheduler.request(proof);
  }

  acceptToggleOff(configuration: ConfigurationStore): AcceptedSettingsToggleOffRequest | null {
    return acceptSettingsToggleOffRequest(() => configuration.current.configuration);
  }

  setPreviewFailureListener(listener: ((failure: PreviewFailure) => void) | null): void {
    this.#previewFailureListener = listener;
  }

  notifyPreviewFailure(failure: PreviewFailure): void {
    this.#previewFailureListener?.(failure);
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
    this.#previewFailureListener = null;
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
  let runtime: AudioSessionRuntime | null = null;
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
    onPreviewFailure: (failure) => runtime?.notifyPreviewFailure(failure),
    launchPlayer: (cue) => {
      if (launchPlayer === null) throw new Error("Unsupported audio platform");
      return launchPlayer(cue);
    },
  });
  runtime = new AudioSessionRuntime(scheduler);
  return runtime;
}

/** The currently visible Settings overlay and its session-bound controls. */
interface LiveSettingsController {
  readonly generation: number;
  readonly state: SettingsStateMachine;
  focus(): void;
  dispose(): void;
}

function configurationWarningMessage(
  warning: ConfigurationStore["current"]["warning"],
): string | null {
  if (warning === "malformed")
    return "Audio settings found malformed configuration; using defaults.";
  if (warning === "unsupported-version") {
    return "Audio settings cannot change a configuration written by a newer version.";
  }
  if (warning === "symlink" || warning === "unreadable") {
    return "Audio settings cannot read or safely change the configuration file.";
  }
  return null;
}

/** Register Pi hooks and the state-free command while retaining one active session runtime. */
export function registerAudioFeedbackExtension(
  pi: ExtensionAPI,
  options: AudioFeedbackRuntimeOptions = {},
): void {
  const agentDirectory = options.agentDirectory ?? getAgentDir();
  let runtime: AudioSessionRuntime | null = null;
  let configuration: ConfigurationStore | null = null;
  let settings: LiveSettingsController | null = null;
  let settingsPromise: Promise<void> | null = null;
  let sessionGeneration = 0;

  const closeSettingsForTeardown = (): void => {
    const current = settings;
    settings = null;
    current?.dispose();
  };

  const openSettings = async (ctx: ExtensionCommandContext): Promise<void> => {
    if (ctx.mode !== "tui") return;
    const currentRuntime = runtime;
    const currentConfiguration = configuration;
    if (currentRuntime === null || currentConfiguration === null) return;
    if (!ctx.isIdle()) {
      ctx.ui.notify("Audio settings are available when Pi is idle.", "info");
      return;
    }
    if (settings !== null) {
      settings.focus();
      return;
    }

    const generation = sessionGeneration;
    let openedController: LiveSettingsController | null = null;
    try {
      const loaded = await currentConfiguration.load();
      if (
        generation !== sessionGeneration ||
        runtime !== currentRuntime ||
        configuration !== currentConfiguration
      ) {
        return;
      }
      const warning = configurationWarningMessage(loaded.warning);
      if (warning !== null) ctx.ui.notify(warning, "warning");

      let finish: (() => void) | null = null;
      let focusOverlay = (): void => undefined;
      let requestRender = (): void => undefined;
      const state = new SettingsStateMachine(
        {
          configuration: currentConfiguration,
          audio: {
            request: (event, requestOptions) => currentRuntime.request(event, requestOptions),
            requestAcceptedToggleOff: (proof) => currentRuntime.requestAcceptedToggleOff(proof),
            acceptToggleOff: () => currentRuntime.acceptToggleOff(currentConfiguration),
          },
          notifyFailure: () => {
            ctx.ui.notify(
              "Audio settings could not be saved; the previous value was restored.",
              "error",
            );
          },
          requestRender: () => {
            requestRender();
          },
          close: () => {
            finish?.();
          },
        },
        loaded,
      );
      const controller: LiveSettingsController = {
        generation,
        state,
        focus: () => {
          focusOverlay();
          requestRender();
        },
        dispose: () => {
          state.dispose();
        },
      };
      openedController = controller;
      settings = controller;
      currentRuntime.setPreviewFailureListener(() => {
        if (settings === controller && state.level === "themes" && !state.isClosed) {
          ctx.ui.notify("Audio theme preview could not be launched.", "warning");
        }
      });

      await state.open();
      if (settings !== controller || state.isClosed) return;
      await ctx.ui.custom<undefined>(
        (tui, theme, keybindings, done) => {
          let finished = false;
          finish = () => {
            if (finished) return;
            finished = true;
            done(undefined);
          };
          requestRender = () => {
            tui.requestRender();
          };
          return new AudioSettingsComponent({
            state,
            keybindings,
            requestRender,
            styleTitle: (text) => theme.fg("accent", theme.bold(text)),
            styleSelected: (text) => theme.fg("accent", text),
            styleMuted: (text) => theme.fg("dim", text),
          });
        },
        {
          overlay: true,
          overlayOptions: { width: "70%", minWidth: 42, maxHeight: "90%" },
          onHandle: (handle) => {
            focusOverlay = () => {
              handle.focus();
            };
          },
        },
      );
    } catch {
      // Expected load, UI, and feedback failures never reject into Pi or write output.
    } finally {
      if (openedController !== null && settings === openedController) {
        settings = null;
        currentRuntime.setPreviewFailureListener(null);
      }
    }
  };

  // Factory-time registration keeps the command present in TUI, RPC, JSON, and print modes.
  pi.registerCommand("audio:config", {
    description: "Configure audio feedback",
    handler: async (_args, ctx) => {
      if (settingsPromise !== null) {
        settings?.focus();
        return;
      }
      const operation = openSettings(ctx);
      settingsPromise = operation;
      try {
        await operation;
      } finally {
        if (settingsPromise === operation) settingsPromise = null;
      }
    },
  });

  pi.on("session_start", async (event, ctx) => {
    const generation = ++sessionGeneration;
    settingsPromise = null;
    closeSettingsForTeardown();
    runtime?.shutdown();
    runtime = null;
    configuration = null;

    const nextConfiguration = new ConfigurationStore({
      agentDirectory,
      ...(options.configurationFileSystem === undefined
        ? {}
        : { fileSystem: options.configurationFileSystem }),
    });
    try {
      await nextConfiguration.load();
      if (generation !== sessionGeneration) return;
      const nextRuntime = createSessionRuntime(ctx, nextConfiguration, options);
      configuration = nextConfiguration;
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
    settingsPromise = null;
    closeSettingsForTeardown();
    const current = runtime;
    runtime = null;
    configuration = null;
    try {
      current?.shutdown();
    } catch {
      // Shutdown remains idempotent even if an injected resource behaves unexpectedly.
    }
  });
}

/** Pi extension factory registers all hooks and commands synchronously. */
export default function audioFeedbackExtension(pi: ExtensionAPI): void {
  registerAudioFeedbackExtension(pi);
}
