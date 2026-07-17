import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import audioFeedbackExtension from "../extensions/index.js";
import { ConfigurationStore, DEFAULT_CONFIGURATION } from "../extensions/config.js";

function isCallable(value: unknown): value is (...arguments_: unknown[]) => unknown {
  return typeof value === "function";
}

describe("extension configuration lifecycle", () => {
  it("registers session_start and reloads configuration for every session boundary", async () => {
    const load = vi.spyOn(ConfigurationStore.prototype, "load").mockResolvedValue({
      path: "/agent/pi-audio-feedback.json",
      classification: "missing",
      warning: null,
      configuration: DEFAULT_CONFIGURATION,
    });
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;

    audioFeedbackExtension(pi);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("session_start");

    const handler: unknown = on.mock.calls[0]?.[1];
    if (!isCallable(handler)) throw new TypeError("session_start handler was not registered");
    await handler({ reason: "startup" }, {});
    await handler({ reason: "reload" }, {});

    expect(load).toHaveBeenCalledTimes(2);
  });
});
