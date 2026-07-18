import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

import {
  AUDIO_EVENTS,
  AUDIO_THEMES,
  EDITABLE_AUDIO_EVENTS,
  type AudioEvent,
  type AudioTheme,
} from "./audio-catalog.js";
import type { ConfigurationMutation, ConfigurationSnapshot, MutationResult } from "./config.js";
import type { AcceptedSettingsToggleOffRequest } from "./eligibility.js";
import type { SchedulerRequestResult } from "./scheduler.js";

export const ROOT_SETTINGS_OPTIONS = [
  "Turn all sounds on",
  "Turn all sounds off",
  "Edit individual sound playback",
  "Select Audio Theme",
] as const;

export const THEME_SETTINGS_OPTIONS = ["Core", "Retro", "Organic", "Soft"] as const;

export const THEME_SELECTOR_HELPER = "Space preview • Enter save • Esc cancel";

export type SettingsLevel = "root" | "events" | "themes";
export type SettingsNavigation = "up" | "down" | "pageUp" | "pageDown" | "home" | "end";

export interface SettingsAudioRequests {
  request(
    event: AudioEvent,
    options?: { readonly themeOverride?: AudioTheme },
  ): Promise<SchedulerRequestResult>;
  requestAcceptedToggleOff(
    proof: AcceptedSettingsToggleOffRequest,
  ): Promise<SchedulerRequestResult>;
  acceptToggleOff(): AcceptedSettingsToggleOffRequest | null;
}

export interface SettingsConfigurationStore {
  readonly current: ConfigurationSnapshot;
  mutate(mutation: ConfigurationMutation): Promise<MutationResult>;
}

export interface SettingsStateMachineOptions {
  readonly configuration: SettingsConfigurationStore;
  readonly audio: SettingsAudioRequests;
  readonly notifyFailure: () => void;
  readonly requestRender: () => void;
  readonly close: () => void;
}

const PAGE_SIZES = {
  root: ROOT_SETTINGS_OPTIONS.length,
  events: 8,
  themes: AUDIO_THEMES.length,
} as const satisfies Readonly<Record<SettingsLevel, number>>;

function listLength(level: SettingsLevel): number {
  if (level === "root") return ROOT_SETTINGS_OPTIONS.length;
  if (level === "events") return EDITABLE_AUDIO_EVENTS.length;
  return AUDIO_THEMES.length;
}

function allEventValues(value: boolean): Record<AudioEvent, boolean> {
  return Object.fromEntries(AUDIO_EVENTS.map((event) => [event, value])) as Record<
    AudioEvent,
    boolean
  >;
}

/** Deterministic Settings semantics independent of Pi rendering and terminal input. */
export class SettingsStateMachine {
  readonly #options: SettingsStateMachineOptions;
  #level: SettingsLevel = "root";
  #selected: Record<SettingsLevel, number> = { root: 0, events: 0, themes: 0 };
  #configuration: ConfigurationSnapshot;
  #closed = false;
  #operations: Promise<void> = Promise.resolve();

  constructor(options: SettingsStateMachineOptions, configuration: ConfigurationSnapshot) {
    this.#options = options;
    this.#configuration = configuration;
    this.#selected.themes = AUDIO_THEMES.indexOf(configuration.configuration.theme);
  }

  get level(): SettingsLevel {
    return this.#level;
  }

  get selectedIndex(): number {
    return this.#selected[this.#level];
  }

  get configuration(): ConfigurationSnapshot {
    return this.#configuration;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.#operations.then(operation, operation);
    this.#operations = next.catch(() => {
      // Expected UI operations are contained so a later key remains usable.
    });
    return this.#operations;
  }

  async open(): Promise<void> {
    await this.#request("settingsRootEnter");
  }

  async navigate(direction: SettingsNavigation): Promise<void> {
    if (this.#closed) return;
    const current = this.selectedIndex;
    const maximum = listLength(this.#level) - 1;
    const page = PAGE_SIZES[this.#level];
    let candidate = current;
    if (direction === "up") candidate -= 1;
    if (direction === "down") candidate += 1;
    if (direction === "pageUp") candidate -= page;
    if (direction === "pageDown") candidate += page;
    if (direction === "home") candidate = 0;
    if (direction === "end") candidate = maximum;
    candidate = Math.max(0, Math.min(maximum, candidate));
    if (candidate === current) return;
    this.#selected[this.#level] = candidate;
    this.#options.requestRender();
    await this.#request("settingsNavigate");
  }

  async confirm(): Promise<void> {
    if (this.#closed) return;
    if (this.#level === "root") {
      await this.#confirmRoot();
    } else if (this.#level === "events") {
      await this.#toggleSelectedEvent();
    } else {
      await this.#saveSelectedTheme();
    }
  }

  async preview(): Promise<void> {
    if (this.#closed || this.#level !== "themes") return;
    const theme = AUDIO_THEMES[this.selectedIndex];
    if (theme !== undefined) await this.#request("settingsThemePreview", { themeOverride: theme });
  }

  async cancel(): Promise<void> {
    if (this.#closed) return;
    if (this.#level === "root") {
      this.#closed = true;
      await this.#request("settingsRootExit");
      this.#options.close();
      return;
    }
    this.#level = "root";
    this.#options.requestRender();
    await this.#request("settingsSubmenuExit");
  }

  /** Close during session teardown without inventing an explicit user exit cue. */
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#options.close();
  }

  async #confirmRoot(): Promise<void> {
    if (this.selectedIndex === 0) {
      await this.#setAllEvents(true);
      return;
    }
    if (this.selectedIndex === 1) {
      await this.#setAllEvents(false);
      return;
    }
    if (this.selectedIndex === 2) {
      this.#level = "events";
    } else {
      this.#level = "themes";
      this.#selected.themes = AUDIO_THEMES.indexOf(this.#configuration.configuration.theme);
    }
    this.#options.requestRender();
    await this.#request("settingsSubmenuEnter");
  }

  async #setAllEvents(enabled: boolean): Promise<void> {
    if (
      AUDIO_EVENTS.every((event) => this.#configuration.configuration.events[event] === enabled)
    ) {
      return;
    }
    if (!enabled) await this.#requestToggleOffBeforeSave();
    const result = await this.#options.configuration.mutate({ events: allEventValues(enabled) });
    if (this.#closed) return;
    if (!result.ok) {
      this.#mutationFailed();
      return;
    }
    this.#configuration = this.#options.configuration.current;
    this.#options.requestRender();
    if (enabled) await this.#request("settingsToggleOn");
  }

  async #toggleSelectedEvent(): Promise<void> {
    const event = EDITABLE_AUDIO_EVENTS[this.selectedIndex];
    if (event === undefined) return;
    const enabled = !this.#configuration.configuration.events[event];
    if (!enabled) await this.#requestToggleOffBeforeSave();
    const result = await this.#options.configuration.mutate({ events: { [event]: enabled } });
    if (this.#closed) return;
    if (!result.ok) {
      this.#mutationFailed();
      return;
    }
    this.#configuration = this.#options.configuration.current;
    this.#options.requestRender();
    if (enabled) await this.#request("settingsToggleOn");
  }

  async #saveSelectedTheme(): Promise<void> {
    const theme = AUDIO_THEMES[this.selectedIndex];
    if (theme === undefined) return;
    const result = await this.#options.configuration.mutate({ theme });
    if (this.#closed) return;
    if (!result.ok) {
      this.#mutationFailed();
      return;
    }
    this.#configuration = this.#options.configuration.current;
    this.#options.requestRender();
    await this.#request("settingsOptionSelect");
  }

  async #requestToggleOffBeforeSave(): Promise<void> {
    const proof = this.#options.audio.acceptToggleOff();
    if (proof !== null) await this.#options.audio.requestAcceptedToggleOff(proof);
  }

  #mutationFailed(): void {
    this.#configuration = this.#options.configuration.current;
    this.#options.requestRender();
    this.#options.notifyFailure();
  }

  async #request(
    event: AudioEvent,
    options?: { readonly themeOverride?: AudioTheme },
  ): Promise<void> {
    try {
      await this.#options.audio.request(event, options);
    } catch {
      // Settings audio is feedback only and must never reject a Pi command or key handler.
    }
  }
}

interface SettingsComponentOptions {
  readonly state: SettingsStateMachine;
  readonly keybindings: KeybindingsManager;
  readonly requestRender: () => void;
  readonly styleTitle: (text: string) => string;
  readonly styleSelected: (text: string) => string;
  readonly styleMuted: (text: string) => string;
  /** Public Pi borders are injected at the extension runtime boundary when this UI is assembled. */
  readonly topBorder?: Component;
  readonly bottomBorder?: Component;
}

function navigationForInput(
  data: string,
  keybindings: KeybindingsManager,
): SettingsNavigation | null {
  if (keybindings.matches(data, "tui.select.up")) return "up";
  if (keybindings.matches(data, "tui.select.down")) return "down";
  if (keybindings.matches(data, "tui.select.pageUp")) return "pageUp";
  if (keybindings.matches(data, "tui.select.pageDown")) return "pageDown";
  if (matchesKey(data, Key.home)) return "home";
  if (matchesKey(data, Key.end)) return "end";
  return null;
}

/** Complete keyboard-driven Settings component backed by the semantic state machine. */
export class AudioSettingsComponent implements Component {
  readonly #options: SettingsComponentOptions;

  constructor(options: SettingsComponentOptions) {
    this.#options = options;
  }

  handleInput(data: string): void {
    const state = this.#options.state;
    const navigation = navigationForInput(data, this.#options.keybindings);
    let operation: (() => Promise<void>) | null = null;
    if (navigation !== null) operation = () => state.navigate(navigation);
    else if (this.#options.keybindings.matches(data, "tui.select.cancel")) {
      operation = () => state.cancel();
    } else if (matchesKey(data, Key.space) && state.level === "themes") {
      operation = () => state.preview();
    } else if (this.#options.keybindings.matches(data, "tui.select.confirm")) {
      operation = () => state.confirm();
    }
    if (operation === null) return;
    void state.enqueue(operation).finally(this.#options.requestRender);
  }

  render(width: number): string[] {
    const state = this.#options.state;
    const lines = [this.#options.styleTitle(this.#title(state.level)), ""];
    for (const [index, label] of this.#items().entries()) {
      const line = `${index === state.selectedIndex ? ">" : " "} ${label}`;
      lines.push(index === state.selectedIndex ? this.#options.styleSelected(line) : line);
    }
    lines.push("");
    lines.push(
      this.#options.styleMuted(
        state.level === "themes"
          ? THEME_SELECTOR_HELPER
          : "↑/↓ navigate • Enter select • Esc cancel",
      ),
    );
    const safeWidth = Math.max(0, width);
    const renderBorder = (border: Component | undefined): string[] =>
      border?.render(safeWidth).map((line) => truncateToWidth(line, safeWidth, "")) ?? [];
    return [
      ...renderBorder(this.#options.topBorder),
      ...lines.map((line) => truncateToWidth(line, safeWidth, "")),
      ...renderBorder(this.#options.bottomBorder),
    ];
  }

  invalidate(): void {
    this.#options.topBorder?.invalidate();
    this.#options.bottomBorder?.invalidate();
    // Content styling callbacks use the callback-provided Pi theme on every render.
  }

  #title(level: SettingsLevel): string {
    if (level === "root") return "Audio Settings";
    if (level === "events") return "Edit individual sound playback";
    return "Select Audio Theme";
  }

  #items(): string[] {
    const state = this.#options.state;
    if (state.level === "root") return [...ROOT_SETTINGS_OPTIONS];
    if (state.level === "events") {
      return EDITABLE_AUDIO_EVENTS.map(
        (event) => `${event} [${state.configuration.configuration.events[event] ? "on" : "off"}]`,
      );
    }
    return AUDIO_THEMES.map((theme, index) => {
      const label = THEME_SETTINGS_OPTIONS[index] ?? theme;
      return `${label}${state.configuration.configuration.theme === theme ? " (saved)" : ""}`;
    });
  }
}
