import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const publicPiApi = vi.hoisted(() => ({
  getAgentDir: vi.fn(() => "/managed/pi-agent"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => publicPiApi);

function isCallable(value: unknown): value is (...arguments_: unknown[]) => unknown {
  return typeof value === "function";
}

describe("extension configuration lifecycle", () => {
  it("binds Pi's public getAgentDir export and reloads at every session boundary", async () => {
    const { ConfigurationStore, DEFAULT_CONFIGURATION } = await import("../extensions/config.js");
    const load = vi.spyOn(ConfigurationStore.prototype, "load").mockResolvedValue({
      path: "/managed/pi-agent/pi-audio-feedback.json",
      classification: "missing",
      warning: null,
      configuration: DEFAULT_CONFIGURATION,
    });
    const { default: audioFeedbackExtension } = await import("../extensions/index.js");
    const on = vi.fn();
    const pi = { on } as unknown as ExtensionAPI;

    audioFeedbackExtension(pi);
    expect(publicPiApi.getAgentDir).toHaveBeenCalledOnce();
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]?.[0]).toBe("session_start");

    const handler: unknown = on.mock.calls[0]?.[1];
    if (!isCallable(handler)) throw new TypeError("session_start handler was not registered");
    await handler({ reason: "startup" }, {});
    await handler({ reason: "reload" }, {});

    expect(load).toHaveBeenCalledTimes(2);
  });
});
