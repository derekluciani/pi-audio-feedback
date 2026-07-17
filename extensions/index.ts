import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ConfigurationStore } from "./config.js";

export * from "./config.js";

/** Loads global audio configuration at every Pi session boundary. */
export default function audioFeedbackExtension(pi: ExtensionAPI): void {
  const configuration = new ConfigurationStore({ agentDirectory: getAgentDir() });

  pi.on("session_start", async () => {
    await configuration.load();
  });
}

export * from "./audio-catalog.js";
export * from "./eligibility.js";

export * from "./scheduler.js";

export * from "./platform-adapters.js";

export * from "./terminal-outcomes.js";
