import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  AUDIO_EVENTS,
  AUDIO_THEMES,
  EDITABLE_AUDIO_EVENTS,
  type AudioEvent,
  type AudioTheme,
} from "../extensions/audio-catalog.js";
import {
  DEFAULT_CONFIGURATION,
  type AudioFeedbackConfiguration,
  type ConfigurationMutation,
  type ConfigurationSnapshot,
  type MutationResult,
} from "../extensions/config.js";
import {
  acceptSettingsToggleOffRequest,
  type AcceptedSettingsToggleOffRequest,
} from "../extensions/eligibility.js";
import {
  AudioSettingsComponent,
  ROOT_SETTINGS_OPTIONS,
  SettingsStateMachine,
  THEME_SELECTOR_HELPER,
  THEME_SETTINGS_OPTIONS,
  type SettingsAudioRequests,
  type SettingsConfigurationStore,
} from "../extensions/settings.js";

function cloneConfiguration(configuration: AudioFeedbackConfiguration): AudioFeedbackConfiguration {
  return {
    version: 1,
    theme: configuration.theme,
    events: { ...configuration.events },
  };
}

class FakeConfigurationStore implements SettingsConfigurationStore {
  readonly mutations: ConfigurationMutation[] = [];
  failNext = false;
  #configuration: AudioFeedbackConfiguration;

  constructor(configuration: AudioFeedbackConfiguration = DEFAULT_CONFIGURATION) {
    this.#configuration = cloneConfiguration(configuration);
  }

  get current(): ConfigurationSnapshot {
    return {
      path: "/agent/pi-audio-feedback.json",
      classification: "valid",
      warning: null,
      configuration: cloneConfiguration(this.#configuration),
    };
  }

  mutate(mutation: ConfigurationMutation): Promise<MutationResult> {
    this.mutations.push(mutation);
    if (this.failNext) {
      this.failNext = false;
      return Promise.resolve({ ok: false, reason: "write-failed" });
    }
    const eventPatch =
      typeof mutation.events === "object" && mutation.events !== null ? mutation.events : {};
    this.#configuration = {
      version: 1,
      theme: (mutation.theme as AudioTheme | undefined) ?? this.#configuration.theme,
      events: { ...this.#configuration.events, ...eventPatch },
    };
    return Promise.resolve({ ok: true, configuration: cloneConfiguration(this.#configuration) });
  }
}

interface MachineHarness {
  readonly state: SettingsStateMachine;
  readonly store: FakeConfigurationStore;
  readonly requests: Array<
    | { event: AudioEvent; themeOverride?: AudioTheme }
    | { event: "settingsToggleOff"; accepted: true }
  >;
  readonly notifyFailure: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly renders: ReturnType<typeof vi.fn>;
}

function createMachine(
  configuration: AudioFeedbackConfiguration = DEFAULT_CONFIGURATION,
): MachineHarness {
  const store = new FakeConfigurationStore(configuration);
  const requests: MachineHarness["requests"] = [];
  const audio: SettingsAudioRequests = {
    request: (event, options) => {
      requests.push({
        event,
        ...(options?.themeOverride ? { themeOverride: options.themeOverride } : {}),
      });
      return Promise.resolve("accepted");
    },
    requestAcceptedToggleOff: (proof: AcceptedSettingsToggleOffRequest) => {
      expect(proof.event).toBe("settingsToggleOff");
      requests.push({ event: "settingsToggleOff", accepted: true });
      return Promise.resolve("accepted");
    },
    acceptToggleOff: () => acceptSettingsToggleOffRequest(() => store.current.configuration),
  };
  const notifyFailure = vi.fn();
  const close = vi.fn();
  const renders = vi.fn();
  return {
    store,
    requests,
    notifyFailure,
    close,
    renders,
    state: new SettingsStateMachine(
      { configuration: store, audio, notifyFailure, close, requestRender: renders },
      store.current,
    ),
  };
}

function withEvents(
  events: Partial<Record<AudioEvent, boolean>>,
  theme: AudioTheme = "core",
): AudioFeedbackConfiguration {
  return {
    version: 1,
    theme,
    events: { ...DEFAULT_CONFIGURATION.events, ...events },
  };
}

describe("audio Settings semantic state machine", () => {
  it("publishes exact root, event-editor, theme, and helper labels", () => {
    expect(ROOT_SETTINGS_OPTIONS).toEqual([
      "Turn all sounds on",
      "Turn all sounds off",
      "Edit individual sound playback",
      "Select Audio Theme",
    ]);
    expect(EDITABLE_AUDIO_EVENTS).toEqual([
      "appStart",
      "agentStart",
      "toolError",
      "agentAborted",
      "agentSettled",
      "settingsRootEnter",
      "settingsRootExit",
      "settingsSubmenuEnter",
      "settingsSubmenuExit",
      "settingsNavigate",
      "settingsOptionSelect",
      "settingsToggleOn",
      "settingsToggleOff",
    ]);
    expect(EDITABLE_AUDIO_EVENTS).not.toContain("settingsThemePreview");
    expect(AUDIO_THEMES).toEqual(["core", "retro", "organic", "soft"]);
    expect(THEME_SETTINGS_OPTIONS).toEqual(["Core", "Retro", "Organic", "Soft"]);
    expect(THEME_SELECTOR_HELPER).toBe("Space preview • Enter save • Esc cancel");
  });

  it("renders semantic theme labels and routes only supported keyboard controls", async () => {
    const harness = createMachine();
    const keybindings = {
      matches: (data: string, binding: string) => {
        const controls: Readonly<Record<string, readonly string[]>> = {
          "tui.select.up": ["up", "custom-up"],
          "tui.select.down": ["down"],
          "tui.select.pageUp": ["pageUp"],
          "tui.select.pageDown": ["pageDown"],
          "tui.select.confirm": ["enter"],
          "tui.select.cancel": ["escape", "ctrl+c"],
        };
        return controls[binding]?.includes(data) ?? false;
      },
    } as unknown as KeybindingsManager;
    const component = new AudioSettingsComponent({
      state: harness.state,
      keybindings,
      requestRender: harness.renders,
      styleTitle: (text) => text,
      styleSelected: (text) => text,
      styleMuted: (text) => text,
    });

    component.handleInput("x");
    component.handleInput("custom-up");
    expect(harness.requests).toEqual([]);
    component.handleInput("\u001b[F");
    component.handleInput("enter");
    await vi.waitFor(() => {
      expect(harness.state.level).toBe("themes");
    });
    expect(component.render(80)).toEqual(
      expect.arrayContaining(["> Core (saved)", "  Retro", "  Organic", "  Soft"]),
    );
    expect(component.render(80)).toContain(THEME_SELECTOR_HELPER);

    harness.requests.splice(0);
    component.handleInput("\u001b[H");
    component.handleInput("pageDown");
    component.handleInput("down");
    component.handleInput(" ");
    await vi.waitFor(() => {
      expect(harness.requests.map(({ event }) => event)).toEqual([
        "settingsNavigate",
        "settingsThemePreview",
      ]);
    });
    component.handleInput("letter");
    await Promise.resolve();
    expect(harness.requests.map(({ event }) => event)).toEqual([
      "settingsNavigate",
      "settingsThemePreview",
    ]);
  });

  it("clamps every movement and requests navigation only for an actual change", async () => {
    const harness = createMachine();
    await harness.state.open();
    await harness.state.navigate("up");
    await harness.state.navigate("home");
    expect(harness.requests.map(({ event }) => event)).toEqual(["settingsRootEnter"]);

    await harness.state.navigate("pageDown");
    expect(harness.state.selectedIndex).toBe(3);
    await harness.state.navigate("down");
    await harness.state.navigate("end");
    await harness.state.navigate("pageUp");
    expect(harness.state.selectedIndex).toBe(0);
    expect(harness.requests.map(({ event }) => event)).toEqual([
      "settingsRootEnter",
      "settingsNavigate",
      "settingsNavigate",
    ]);
  });

  it("enters and exits one active level with exactly one corresponding cue", async () => {
    const harness = createMachine();
    await harness.state.open();
    await harness.state.navigate("pageDown");
    await harness.state.navigate("up");
    await harness.state.confirm();
    expect(harness.state.level).toBe("events");
    await harness.state.cancel();
    expect(harness.state.level).toBe("root");
    await harness.state.cancel();
    expect(harness.close).toHaveBeenCalledOnce();
    expect(harness.requests.map(({ event }) => event)).toEqual([
      "settingsRootEnter",
      "settingsNavigate",
      "settingsNavigate",
      "settingsSubmenuEnter",
      "settingsSubmenuExit",
      "settingsRootExit",
    ]);
  });

  it("applies all-on after one atomic write and all-off after authentic pre-save acceptance", async () => {
    const onHarness = createMachine(withEvents({ appStart: false, settingsToggleOn: false }));
    await onHarness.state.confirm();
    expect(onHarness.store.mutations).toHaveLength(1);
    expect(onHarness.store.mutations[0]).toEqual({
      events: Object.fromEntries(AUDIO_EVENTS.map((event) => [event, true])),
    });
    expect(onHarness.requests.map(({ event }) => event)).toEqual(["settingsToggleOn"]);

    const offHarness = createMachine();
    await offHarness.state.navigate("down");
    await offHarness.state.confirm();
    expect(offHarness.requests.map(({ event }) => event)).toEqual([
      "settingsNavigate",
      "settingsToggleOff",
    ]);
    expect(offHarness.store.current.configuration.events).toEqual(
      Object.fromEntries(AUDIO_EVENTS.map((event) => [event, false])),
    );
  });

  it("does not write or cue all-on/all-off no-op actions", async () => {
    const allOn = createMachine();
    await allOn.state.confirm();
    expect(allOn.store.mutations).toEqual([]);
    expect(allOn.requests).toEqual([]);

    const allOff = createMachine(
      withEvents(Object.fromEntries(AUDIO_EVENTS.map((event) => [event, false]))),
    );
    await allOff.state.navigate("down");
    allOff.requests.splice(0);
    await allOff.state.confirm();
    expect(allOff.store.mutations).toEqual([]);
    expect(allOff.requests).toEqual([]);
  });

  it("saves individual toggles in the required cue order and reverts failed writes", async () => {
    const enabling = createMachine(withEvents({ appStart: false }));
    await enabling.state.navigate("pageDown");
    await enabling.state.navigate("up");
    await enabling.state.confirm();
    enabling.requests.splice(0);
    await enabling.state.confirm();
    expect(enabling.store.current.configuration.events.appStart).toBe(true);
    expect(enabling.requests.map(({ event }) => event)).toEqual(["settingsToggleOn"]);

    const disabling = createMachine();
    await disabling.state.navigate("pageDown");
    await disabling.state.navigate("up");
    await disabling.state.confirm();
    disabling.requests.splice(0);
    disabling.store.failNext = true;
    await disabling.state.confirm();
    expect(disabling.requests.map(({ event }) => event)).toEqual(["settingsToggleOff"]);
    expect(disabling.store.current.configuration.events.appStart).toBe(true);
    expect(disabling.notifyFailure).toHaveBeenCalledOnce();
  });

  it("previews only the unsaved candidate and confirms under the newly saved theme", async () => {
    const harness = createMachine();
    await harness.state.navigate("end");
    await harness.state.confirm();
    expect(harness.state.level).toBe("themes");
    harness.requests.splice(0);
    await harness.state.navigate("down");
    await harness.state.preview();
    expect(harness.store.mutations).toEqual([]);
    expect(harness.requests).toEqual([
      { event: "settingsNavigate" },
      { event: "settingsThemePreview", themeOverride: "retro" },
    ]);

    harness.requests.splice(0);
    await harness.state.confirm();
    expect(harness.store.current.configuration.theme).toBe("retro");
    expect(harness.requests).toEqual([{ event: "settingsOptionSelect" }]);
  });

  it("preserves the confirmed theme on cancel and emits no post-save cue on failure", async () => {
    const harness = createMachine(DEFAULT_CONFIGURATION);
    await harness.state.navigate("end");
    await harness.state.confirm();
    await harness.state.navigate("down");
    harness.requests.splice(0);
    await harness.state.cancel();
    expect(harness.store.current.configuration.theme).toBe("core");
    expect(harness.requests).toEqual([{ event: "settingsSubmenuExit" }]);

    await harness.state.navigate("end");
    await harness.state.confirm();
    await harness.state.navigate("down");
    harness.requests.splice(0);
    harness.store.failNext = true;
    await harness.state.confirm();
    expect(harness.store.current.configuration.theme).toBe("core");
    expect(harness.requests).toEqual([]);
    expect(harness.notifyFailure).toHaveBeenCalledOnce();
  });
});
