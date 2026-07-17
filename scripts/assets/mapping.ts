export const THEMES = ["core", "retro", "organic", "soft"] as const;
export type Theme = (typeof THEMES)[number];

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
} as const satisfies Record<string, Record<Theme, string>>;

export type LogicalEvent = keyof typeof EVENT_SOUND_MAPPING;
