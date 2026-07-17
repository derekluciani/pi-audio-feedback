import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfigurationStore } from "./config.js";

export * from "./config.js";

/** Loads global audio configuration at every Pi session boundary. */
export default function audioFeedbackExtension(pi: ExtensionAPI): void {
  const configuration = new ConfigurationStore();

  pi.on("session_start", async () => {
    await configuration.load();
  });
}
