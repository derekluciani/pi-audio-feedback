/** Built-in theme identifiers. Custom themes are not part of the supported configuration surface. */
export const AUDIO_THEMES = ["core", "retro", "organic", "soft"] as const;
export type AudioTheme = (typeof AUDIO_THEMES)[number];

/** Every runtime event with a persisted enable/disable toggle. */
export const AUDIO_EVENTS = [
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
  "settingsThemePreview",
] as const;
export type AudioEvent = (typeof AUDIO_EVENTS)[number];
export type AudioEventToggles = Readonly<Record<AudioEvent, boolean>>;

/** Default persisted/runtime toggle state for every known event. */
export const DEFAULT_AUDIO_EVENT_TOGGLES: AudioEventToggles = Object.freeze(
  Object.fromEntries(AUDIO_EVENTS.map((event) => [event, true])) as Record<AudioEvent, boolean>,
);

/** Events exposed by the individual-toggle editor; preview has no editor toggle. */
export const EDITABLE_AUDIO_EVENTS = AUDIO_EVENTS.filter(
  (event): event is Exclude<AudioEvent, "settingsThemePreview"> => event !== "settingsThemePreview",
);

/** Larger values have higher scheduler priority. Settings events not named here are lowest. */
export const AUDIO_EVENT_PRIORITIES = {
  agentSettled: 7,
  agentAborted: 6,
  toolError: 5,
  settingsThemePreview: 4,
  appStart: 3,
  agentStart: 2,
  settingsRootEnter: 1,
  settingsRootExit: 1,
  settingsSubmenuEnter: 1,
  settingsSubmenuExit: 1,
  settingsNavigate: 1,
  settingsOptionSelect: 1,
  settingsToggleOn: 1,
  settingsToggleOff: 1,
} as const satisfies Readonly<Record<AudioEvent, number>>;

/** Maintained logical-event to packaged-patch mapping for every built-in theme. */
export const EVENT_SOUND_MAPPING = {
  appStart: { core: "success", retro: "success", organic: "success", soft: "success" },
  agentStart: { core: "copy", retro: "copy", organic: "copy", soft: "copy" },
  toolError: { core: "delete", retro: "error", organic: "error", soft: "error" },
  agentAborted: { core: "warning", retro: "warning", organic: "warning", soft: "warning" },
  agentSettled: {
    core: "notification",
    retro: "notification",
    organic: "notification",
    soft: "notification",
  },
  settingsRootEnter: {
    core: "modal-open",
    retro: "page-enter",
    organic: "page-enter",
    soft: "page-enter",
  },
  settingsRootExit: {
    core: "modal-close",
    retro: "page-exit",
    organic: "page-exit",
    soft: "delete",
  },
  settingsSubmenuEnter: {
    core: "dropdown-open",
    retro: "expand",
    organic: "expand",
    soft: "tab-switch",
  },
  settingsSubmenuExit: {
    core: "dropdown-close",
    retro: "collapse",
    organic: "collapse",
    soft: "undo",
  },
  settingsNavigate: {
    core: "deselect",
    retro: "deselect",
    organic: "deselect",
    soft: "hover",
  },
  settingsOptionSelect: { core: "select", retro: "select", organic: "select", soft: "select" },
  settingsToggleOn: {
    core: "toggle-on",
    retro: "toggle-on",
    organic: "toggle-on",
    soft: "toggle-on",
  },
  settingsToggleOff: {
    core: "toggle-off",
    retro: "toggle-off",
    organic: "toggle-off",
    soft: "toggle-off",
  },
  settingsThemePreview: {
    core: "notification",
    retro: "notification",
    organic: "notification",
    soft: "notification",
  },
} as const satisfies Readonly<Record<AudioEvent, Readonly<Record<AudioTheme, string>>>>;

/** Narrow an untrusted value to a built-in theme. */
export function isAudioTheme(value: unknown): value is AudioTheme {
  return typeof value === "string" && AUDIO_THEMES.some((theme) => theme === value);
}

/** Narrow an untrusted value to a known logical audio event. */
export function isAudioEvent(value: unknown): value is AudioEvent {
  return typeof value === "string" && AUDIO_EVENTS.some((event) => event === value);
}
