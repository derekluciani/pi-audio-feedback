import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { release } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUDIO_EVENTS,
  AUDIO_EVENT_PRIORITIES,
  EVENT_SOUND_MAPPING,
  isAudioEvent,
  isAudioTheme,
  type AudioEvent,
  type AudioTheme,
} from "./audio-catalog.js";
import type { AudioFeedbackConfiguration } from "./config.js";

export const CI_MARKERS = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_ID",
  "BUILD_NUMBER",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "JENKINS_URL",
  "TF_BUILD",
] as const;

export const SSH_MARKERS = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

export type TogglePolicy = "launch" | "accepted";

export type IneligibilityReason =
  | "invalid-request"
  | "invalid-event"
  | "invalid-theme-override"
  | "invalid-toggle-policy"
  | "invalid-configuration"
  | "non-tui"
  | "ci"
  | "ssh"
  | "unsupported-platform"
  | "disabled"
  | "missing-mapping"
  | "missing-wav"
  | "missing-helper";

export interface LaunchableAudioCue {
  readonly launchable: true;
  readonly event: AudioEvent;
  readonly priority: number;
  readonly theme: AudioTheme;
  readonly wavPath: string;
  /** Present only for the native-Windows adapter. */
  readonly powershellHelperPath?: string;
}

export interface NonLaunchableAudioCue {
  readonly launchable: false;
  readonly reason: IneligibilityReason;
}

export type AudioEligibilityResult = LaunchableAudioCue | NonLaunchableAudioCue;

export interface PackagedAudioPaths {
  readonly packageRoot: string;
  readonly wavRoot: string;
  readonly powershellHelperPath: string;
}

interface FileStats {
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface EligibilityFileSystem {
  lstat(path: string): Promise<FileStats>;
  access(path: string, mode: number): Promise<void>;
}

export interface AudioEligibilityOptions {
  /** Invoked during every resolution so queued ordinary requests never snapshot config. */
  readonly getCurrentConfiguration: () => unknown;
  readonly mode: unknown;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  readonly operatingSystemRelease?: string;
  readonly moduleUrl?: string;
  readonly fileSystem?: EligibilityFileSystem;
}

const acceptedRequestBrand: unique symbol = Symbol("acceptedSettingsToggleOffRequest");

/**
 * Opaque scheduler request created only after the runtime verifies the toggle at acceptance time.
 * Runtime authenticity is held separately in a module-private WeakSet, so matching object fields
 * or TypeScript assertions cannot forge acceptance.
 */
export interface AcceptedSettingsToggleOffRequest {
  readonly event: "settingsToggleOff";
  readonly togglePolicy: "accepted";
  readonly [acceptedRequestBrand]: true;
}

const authenticAcceptedRequests = new WeakSet();

interface ParsedRequest {
  readonly event: AudioEvent;
  readonly togglePolicy: TogglePolicy;
  readonly themeOverride: AudioTheme | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** CI values follow PRD section 2.1 exactly; whitespace is a nonempty marker. */
export function hasActiveCiMarker(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return CI_MARKERS.some((name) => {
    const value = environment[name];
    return (
      value !== undefined && value.length > 0 && value.toLowerCase() !== "false" && value !== "0"
    );
  });
}

/** Any nonempty SSH marker suppresses audio, including values such as "false". */
export function hasSshMarker(environment: Readonly<Record<string, string | undefined>>): boolean {
  return SSH_MARKERS.some((name) => {
    const value = environment[name];
    return value !== undefined && value.length > 0;
  });
}

/** Resolve runtime files only from the installed module location, never process.cwd(). */
export function resolvePackagedAudioPaths(moduleUrl: string = import.meta.url): PackagedAudioPaths {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const packageRoot = resolve(moduleDirectory, "..");
  return {
    packageRoot,
    wavRoot: resolve(packageRoot, "assets", "wav"),
    powershellHelperPath: resolve(packageRoot, "scripts", "play-wav.ps1"),
  };
}

function isConfiguration(value: unknown): value is AudioFeedbackConfiguration {
  if (!isRecord(value) || value.version !== 1 || !isAudioTheme(value.theme)) return false;
  const events = value.events;
  if (!isRecord(events)) return false;
  return AUDIO_EVENTS.every((event) => typeof events[event] === "boolean");
}

/**
 * Accept the sole PRD-approved pre-save snapshot using the runtime's current configuration.
 * A null result means the configuration is invalid/unavailable or settingsToggleOff is disabled.
 */
export function acceptSettingsToggleOffRequest(
  getCurrentConfiguration: () => unknown,
): AcceptedSettingsToggleOffRequest | null {
  let configuration: unknown;
  try {
    configuration = getCurrentConfiguration();
  } catch {
    return null;
  }
  if (!isConfiguration(configuration) || !configuration.events.settingsToggleOff) return null;

  // The brand is compile-time opacity; WeakSet membership is the runtime authenticity proof.
  const request = Object.freeze({
    event: "settingsToggleOff",
    togglePolicy: "accepted",
  }) as AcceptedSettingsToggleOffRequest;
  authenticAcceptedRequests.add(request);
  return request;
}

function parseRequest(request: unknown): ParsedRequest | IneligibilityReason {
  if (!isRecord(request)) return "invalid-request";

  if (authenticAcceptedRequests.has(request)) {
    return { event: "settingsToggleOff", togglePolicy: "accepted", themeOverride: null };
  }

  const allowedKeys = new Set(["event", "themeOverride", "togglePolicy"]);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) return "invalid-request";
  if (!isAudioEvent(request.event)) return "invalid-event";

  const policy = request.togglePolicy ?? "launch";
  if (policy !== "launch") return "invalid-toggle-policy";

  let themeOverride: AudioTheme | null = null;
  if (request.themeOverride !== undefined) {
    if (request.event !== "settingsThemePreview" || !isAudioTheme(request.themeOverride)) {
      return "invalid-theme-override";
    }
    themeOverride = request.themeOverride;
  }

  return { event: request.event, togglePolicy: policy, themeOverride };
}

function isWsl(
  environment: Readonly<Record<string, string | undefined>>,
  osRelease: string,
): boolean {
  return (
    (environment.WSL_DISTRO_NAME?.length ?? 0) > 0 ||
    (environment.WSL_INTEROP?.length ?? 0) > 0 ||
    /microsoft|wsl/i.test(osRelease)
  );
}

async function isReadableRegularFile(
  fileSystem: EligibilityFileSystem,
  path: string,
): Promise<boolean> {
  try {
    const metadata = await fileSystem.lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return false;
    await fileSystem.access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const nodeFileSystem: EligibilityFileSystem = { lstat, access };

/**
 * Evaluate every launch-time policy and resolve a packaged WAV for a scheduler request.
 * Expected environment, configuration, mapping, and filesystem failures are returned as
 * typed non-launchable outcomes and never escape into a Pi event handler.
 */
export async function resolveAudioEligibility(
  request: unknown,
  options: AudioEligibilityOptions,
): Promise<AudioEligibilityResult> {
  const parsed = parseRequest(request);
  if (typeof parsed === "string") return { launchable: false, reason: parsed };

  if (options.mode !== "tui") return { launchable: false, reason: "non-tui" };
  const environment = options.environment ?? process.env;
  if (hasActiveCiMarker(environment)) return { launchable: false, reason: "ci" };
  if (hasSshMarker(environment)) return { launchable: false, reason: "ssh" };

  const platform = options.platform ?? process.platform;
  const osRelease = options.operatingSystemRelease ?? release();
  if (
    (platform === "linux" && isWsl(environment, osRelease)) ||
    (platform !== "darwin" && platform !== "linux" && platform !== "win32")
  ) {
    return { launchable: false, reason: "unsupported-platform" };
  }

  let configuration: unknown;
  try {
    configuration = options.getCurrentConfiguration();
  } catch {
    return { launchable: false, reason: "invalid-configuration" };
  }
  if (!isConfiguration(configuration)) {
    return { launchable: false, reason: "invalid-configuration" };
  }
  if (parsed.togglePolicy === "launch" && !configuration.events[parsed.event]) {
    return { launchable: false, reason: "disabled" };
  }

  const theme = parsed.themeOverride ?? configuration.theme;
  const eventMapping: unknown = EVENT_SOUND_MAPPING[parsed.event];
  if (!isRecord(eventMapping)) return { launchable: false, reason: "missing-mapping" };
  const patchName = eventMapping[theme];
  // Patch names are built-in path segments, never caller-provided paths.
  if (typeof patchName !== "string" || !/^[a-z0-9-]+$/.test(patchName)) {
    return { launchable: false, reason: "missing-mapping" };
  }

  let paths: PackagedAudioPaths;
  try {
    paths = resolvePackagedAudioPaths(options.moduleUrl);
  } catch {
    return { launchable: false, reason: "missing-mapping" };
  }
  const wavPath = resolve(paths.wavRoot, theme, `${patchName}.wav`);
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  if (!(await isReadableRegularFile(fileSystem, wavPath))) {
    return { launchable: false, reason: "missing-wav" };
  }
  if (
    platform === "win32" &&
    !(await isReadableRegularFile(fileSystem, paths.powershellHelperPath))
  ) {
    return { launchable: false, reason: "missing-helper" };
  }

  return {
    launchable: true,
    event: parsed.event,
    priority: AUDIO_EVENT_PRIORITIES[parsed.event],
    theme,
    wavPath,
    ...(platform === "win32" ? { powershellHelperPath: paths.powershellHelperPath } : {}),
  };
}
