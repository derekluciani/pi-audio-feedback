import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIO_EVENTS,
  AUDIO_EVENT_PRIORITIES,
  AUDIO_THEMES,
  CI_MARKERS,
  DEFAULT_CONFIGURATION,
  EVENT_SOUND_MAPPING,
  hasActiveCiMarker,
  hasSshMarker,
  resolveAudioEligibility,
  resolvePackagedAudioPaths,
  type AudioFeedbackConfiguration,
} from "../extensions/index.js";

const temporaryDirectories: string[] = [];

function configuration(
  theme: AudioFeedbackConfiguration["theme"] = "core",
  enabled = true,
): AudioFeedbackConfiguration {
  return {
    ...DEFAULT_CONFIGURATION,
    theme,
    events: Object.fromEntries(
      AUDIO_EVENTS.map((event) => [event, enabled]),
    ) as unknown as AudioFeedbackConfiguration["events"],
  };
}

function options(current: () => unknown = () => configuration()) {
  return {
    mode: "tui",
    environment: {},
    platform: "darwin",
    operatingSystemRelease: "",
    getCurrentConfiguration: current,
  } as const;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("environment policy", () => {
  it.each(CI_MARKERS)("checks the exact CI marker %s", (marker) => {
    expect(hasActiveCiMarker({ [marker]: "yes" })).toBe(true);
    expect(hasActiveCiMarker({ [marker]: "FaLsE" })).toBe(false);
    expect(hasActiveCiMarker({ [marker]: "0" })).toBe(false);
    expect(hasActiveCiMarker({ [marker]: "" })).toBe(false);
  });

  it("does not normalize nonempty CI values and treats every SSH value as present", () => {
    expect(hasActiveCiMarker({ CI: " false " })).toBe(true);
    expect(hasSshMarker({ SSH_CONNECTION: "false" })).toBe(true);
    expect(hasSshMarker({ SSH_CLIENT: "0" })).toBe(true);
    expect(hasSshMarker({ SSH_TTY: "" })).toBe(false);
  });

  it.each([
    [{ mode: "rpc" }, "non-tui"],
    [{ environment: { CI: "1" } }, "ci"],
    [{ environment: { SSH_TTY: "tty" } }, "ssh"],
    [
      { platform: "linux", operatingSystemRelease: "microsoft-standard-WSL2" },
      "unsupported-platform",
    ],
    [{ platform: "freebsd" }, "unsupported-platform"],
  ] as const)("silently suppresses policy case %#", async (overrides, reason) => {
    const result = await resolveAudioEligibility(
      { event: "appStart" },
      { ...options(), ...overrides },
    );
    expect(result).toEqual({ launchable: false, reason });
  });
});

describe("launch-time eligibility", () => {
  it("uses the current toggle and theme on every ordinary launch", async () => {
    let current = configuration("core", false);
    const getCurrentConfiguration = vi.fn(() => current);
    expect(
      await resolveAudioEligibility({ event: "agentStart" }, options(getCurrentConfiguration)),
    ).toEqual({ launchable: false, reason: "disabled" });

    current = configuration("soft", true);
    const result = await resolveAudioEligibility(
      { event: "agentStart" },
      options(getCurrentConfiguration),
    );
    expect(result).toMatchObject({
      launchable: true,
      event: "agentStart",
      theme: "soft",
      priority: AUDIO_EVENT_PRIORITIES.agentStart,
    });
    expect(getCurrentConfiguration).toHaveBeenCalledTimes(2);
  });

  it("retains only a validated Settings preview candidate", async () => {
    const result = await resolveAudioEligibility(
      { event: "settingsThemePreview", themeOverride: "organic" },
      options(() => configuration("core")),
    );
    expect(result).toMatchObject({ launchable: true, theme: "organic" });

    await expect(
      resolveAudioEligibility({ event: "appStart", themeOverride: "soft" }, options()),
    ).resolves.toEqual({ launchable: false, reason: "invalid-theme-override" });
    await expect(
      resolveAudioEligibility(
        { event: "settingsThemePreview", themeOverride: "custom" },
        options(),
      ),
    ).resolves.toEqual({ launchable: false, reason: "invalid-theme-override" });
  });

  it("allows only an enabled-at-acceptance toggle-off fact while rechecking other gates", async () => {
    const accepted = {
      event: "settingsToggleOff",
      togglePolicy: "accepted",
      enabledAtAcceptance: true,
    };
    const result = await resolveAudioEligibility(
      accepted,
      options(() => configuration("retro", false)),
    );
    expect(result).toMatchObject({ launchable: true, event: "settingsToggleOff", theme: "retro" });

    await expect(
      resolveAudioEligibility(
        { event: "settingsToggleOff", togglePolicy: "accepted", enabledAtAcceptance: false },
        options(),
      ),
    ).resolves.toEqual({ launchable: false, reason: "invalid-toggle-policy" });
    await expect(
      resolveAudioEligibility(
        { event: "appStart", togglePolicy: "accepted", enabledAtAcceptance: true },
        options(),
      ),
    ).resolves.toEqual({ launchable: false, reason: "invalid-toggle-policy" });
    await expect(
      resolveAudioEligibility(accepted, { ...options(), environment: { CI: "1" } }),
    ).resolves.toEqual({ launchable: false, reason: "ci" });
  });

  it.each([
    [null, "invalid-request"],
    [{ event: "unknown" }, "invalid-event"],
    [{ event: "appStart", togglePolicy: "sometimes" }, "invalid-toggle-policy"],
    [{ event: "appStart", command: "afplay" }, "invalid-request"],
  ] as const)("contains untrusted request %#", async (request, reason) => {
    await expect(resolveAudioEligibility(request, options())).resolves.toEqual({
      launchable: false,
      reason,
    });
  });

  it("contains invalid configuration and filesystem failures", async () => {
    await expect(
      resolveAudioEligibility(
        { event: "appStart" },
        options(() => ({ theme: "core" })),
      ),
    ).resolves.toEqual({ launchable: false, reason: "invalid-configuration" });
    await expect(
      resolveAudioEligibility(
        { event: "appStart" },
        { ...options(), fileSystem: { stat: () => Promise.reject(new Error("unavailable")) } },
      ),
    ).resolves.toEqual({ launchable: false, reason: "missing-wav" });
  });
});

describe("packaged paths", () => {
  it("contains the complete approved mapping", () => {
    expect(Object.keys(EVENT_SOUND_MAPPING)).toEqual(AUDIO_EVENTS);
    for (const event of AUDIO_EVENTS) {
      expect(Object.keys(EVENT_SOUND_MAPPING[event])).toEqual(AUDIO_THEMES);
    }
  });

  it("resolves WAV and helper from an unusual installed module path, not cwd", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "pi audio's-日本語-"));
    temporaryDirectories.push(packageRoot);
    await mkdir(join(packageRoot, "extensions"), { recursive: true });
    await mkdir(join(packageRoot, "assets", "wav", "core"), { recursive: true });
    await mkdir(join(packageRoot, "scripts"), { recursive: true });
    await cp(
      resolve("assets/wav/core/success.wav"),
      join(packageRoot, "assets", "wav", "core", "success.wav"),
    );
    await cp(resolve("scripts/play-wav.ps1"), join(packageRoot, "scripts", "play-wav.ps1"));
    const moduleUrl = pathToFileURL(join(packageRoot, "extensions", "eligibility.ts")).href;
    const paths = resolvePackagedAudioPaths(moduleUrl);
    expect(paths.packageRoot).toBe(packageRoot);
    expect(paths.wavRoot).not.toContain(process.cwd());

    const result = await resolveAudioEligibility(
      { event: "appStart" },
      { ...options(), platform: "win32", moduleUrl },
    );
    expect(result).toEqual({
      launchable: true,
      event: "appStart",
      priority: AUDIO_EVENT_PRIORITIES.appStart,
      theme: "core",
      wavPath: join(packageRoot, "assets", "wav", "core", "success.wav"),
      powershellHelperPath: join(packageRoot, "scripts", "play-wav.ps1"),
    });

    await rm(paths.powershellHelperPath);
    await expect(
      resolveAudioEligibility(
        { event: "appStart" },
        { ...options(), platform: "win32", moduleUrl },
      ),
    ).resolves.toEqual({ launchable: false, reason: "missing-helper" });
  });
});
