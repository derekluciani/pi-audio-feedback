import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONFIG_FILE_NAME = "pi-audio-feedback.json";
export const CONFIG_VERSION = 1 as const;

export const AUDIO_THEMES = ["core", "retro", "organic", "soft"] as const;
export type AudioTheme = (typeof AUDIO_THEMES)[number];

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

export type AudioEventConfiguration = Readonly<Record<AudioEvent, boolean>>;

export interface AudioFeedbackConfiguration {
  readonly version: typeof CONFIG_VERSION;
  readonly theme: AudioTheme;
  readonly events: AudioEventConfiguration;
}

export const DEFAULT_CONFIGURATION: AudioFeedbackConfiguration = Object.freeze({
  version: CONFIG_VERSION,
  theme: "core",
  events: Object.freeze({
    appStart: true,
    agentStart: true,
    toolError: true,
    agentAborted: true,
    agentSettled: true,
    settingsRootEnter: true,
    settingsRootExit: true,
    settingsSubmenuEnter: true,
    settingsSubmenuExit: true,
    settingsNavigate: true,
    settingsOptionSelect: true,
    settingsToggleOn: true,
    settingsToggleOff: true,
    settingsThemePreview: true,
  }),
});

export type ConfigurationWarning = "malformed" | "symlink" | "unreadable" | "unsupported-version";

export type ConfigurationClassification =
  "missing" | "valid" | "malformed" | "symlink" | "unreadable" | "unsupported-version";

export interface ConfigurationSnapshot {
  readonly path: string;
  readonly classification: ConfigurationClassification;
  readonly warning: ConfigurationWarning | null;
  readonly configuration: AudioFeedbackConfiguration;
}

export interface ConfigurationMutation {
  readonly theme?: unknown;
  readonly events?: unknown;
}

export type MutationResult =
  | { readonly ok: true; readonly configuration: AudioFeedbackConfiguration }
  | {
      readonly ok: false;
      readonly reason: "invalid-mutation" | "not-writable" | "write-failed";
    };

/** Minimal file handle used by atomic persistence and replaceable in tests. */
export interface ConfigurationFileHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** Injectable filesystem boundary. Methods must have Node filesystem semantics. */
export interface ConfigurationFileSystem {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  open(path: string, flags: "wx" | "r", mode?: number): Promise<ConfigurationFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

const nodeFileSystem: ConfigurationFileSystem = {
  lstat,
  readFile,
  mkdir,
  open: async (path, flags, mode) => open(path, flags, mode),
  rename,
  unlink,
};

interface ClassifiedConfiguration {
  readonly classification: ConfigurationClassification;
  readonly warning: ConfigurationWarning | null;
  readonly configuration: AudioFeedbackConfiguration;
  readonly persisted: Record<string, unknown> | null;
}

export interface ConfigurationStoreOptions {
  readonly path?: string;
  readonly fileSystem?: ConfigurationFileSystem;
  readonly platform?: NodeJS.Platform;
  readonly uniqueId?: () => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isTheme(value: unknown): value is AudioTheme {
  return typeof value === "string" && AUDIO_THEMES.some((theme) => theme === value);
}

function cloneConfiguration(configuration: AudioFeedbackConfiguration): AudioFeedbackConfiguration {
  return {
    version: CONFIG_VERSION,
    theme: configuration.theme,
    events: { ...configuration.events },
  };
}

function validateVersionOne(record: Record<string, unknown>): ClassifiedConfiguration {
  const rawEvents = isRecord(record.events) ? record.events : {};
  const events = Object.fromEntries(
    AUDIO_EVENTS.map((event) => [
      event,
      typeof rawEvents[event] === "boolean"
        ? rawEvents[event]
        : DEFAULT_CONFIGURATION.events[event],
    ]),
  );

  if (!isCompleteEvents(events)) {
    // Object.fromEntries above is exhaustive; keep the runtime boundary explicit.
    return malformedConfiguration();
  }

  const configuration: AudioFeedbackConfiguration = {
    version: CONFIG_VERSION,
    theme: isTheme(record.theme) ? record.theme : DEFAULT_CONFIGURATION.theme,
    events,
  };
  const persisted: Record<string, unknown> = {
    ...record,
    version: CONFIG_VERSION,
    theme: configuration.theme,
    events: { ...rawEvents, ...configuration.events },
  };

  return {
    classification: "valid",
    warning: null,
    configuration,
    persisted,
  };
}

function isCompleteEvents(value: Record<string, unknown>): value is Record<AudioEvent, boolean> {
  return AUDIO_EVENTS.every((event) => typeof value[event] === "boolean");
}

function malformedConfiguration(): ClassifiedConfiguration {
  return {
    classification: "malformed",
    warning: "malformed",
    configuration: cloneConfiguration(DEFAULT_CONFIGURATION),
    persisted: null,
  };
}

function classifyParsed(value: unknown): ClassifiedConfiguration {
  if (!isRecord(value)) return malformedConfiguration();

  if (typeof value.version === "number" && value.version < CONFIG_VERSION) {
    return malformedConfiguration();
  }
  if (typeof value.version === "number" && value.version > CONFIG_VERSION) {
    return {
      classification: "unsupported-version",
      warning: "unsupported-version",
      configuration: cloneConfiguration(DEFAULT_CONFIGURATION),
      persisted: null,
    };
  }

  // A missing or wrong-type known field receives its version-1 default.
  return validateVersionOne(value);
}

function snapshot(path: string, classified: ClassifiedConfiguration): ConfigurationSnapshot {
  return {
    path,
    classification: classified.classification,
    warning: classified.warning,
    configuration: cloneConfiguration(classified.configuration),
  };
}

function validateMutation(mutation: ConfigurationMutation):
  | {
      readonly valid: true;
      readonly theme?: AudioTheme;
      readonly events?: Partial<Record<AudioEvent, boolean>>;
    }
  | { readonly valid: false } {
  if (!isRecord(mutation)) return { valid: false };
  const keys = Object.keys(mutation);
  if (keys.length === 0 || keys.some((key) => key !== "theme" && key !== "events")) {
    return { valid: false };
  }

  let theme: AudioTheme | undefined;
  if ("theme" in mutation) {
    if (!isTheme(mutation.theme)) return { valid: false };
    theme = mutation.theme;
  }

  let events: Partial<Record<AudioEvent, boolean>> | undefined;
  if ("events" in mutation) {
    if (!isRecord(mutation.events)) return { valid: false };
    const rawEvents = mutation.events;
    const eventKeys = Object.keys(rawEvents);
    if (
      eventKeys.length === 0 ||
      eventKeys.some(
        (key) =>
          !AUDIO_EVENTS.some((event) => event === key) || typeof rawEvents[key] !== "boolean",
      )
    ) {
      return { valid: false };
    }
    events = {};
    for (const event of AUDIO_EVENTS) {
      const value = rawEvents[event];
      if (typeof value === "boolean") events[event] = value;
    }
  }

  return {
    valid: true,
    ...(theme === undefined ? {} : { theme }),
    ...(events === undefined ? {} : { events }),
  };
}

function applyMutation(
  base: ClassifiedConfiguration,
  mutation: { readonly theme?: AudioTheme; readonly events?: Partial<Record<AudioEvent, boolean>> },
): { configuration: AudioFeedbackConfiguration; persisted: Record<string, unknown> } {
  const configuration: AudioFeedbackConfiguration = {
    version: CONFIG_VERSION,
    theme: mutation.theme ?? base.configuration.theme,
    events: { ...base.configuration.events, ...mutation.events },
  };
  const basePersisted = base.persisted ?? {};
  const baseEvents = isRecord(basePersisted.events) ? basePersisted.events : {};
  return {
    configuration,
    persisted: {
      ...basePersisted,
      version: CONFIG_VERSION,
      theme: configuration.theme,
      events: { ...baseEvents, ...configuration.events },
    },
  };
}

/** Resolves the global configuration path. It never consults the project cwd. */
export function getConfigurationPath(agentDirectory: string = getAgentDir()): string {
  return join(agentDirectory, CONFIG_FILE_NAME);
}

/**
 * Owns validated runtime configuration and atomic Settings mutations.
 * Expected filesystem failures are converted to warning/failure values and never logged.
 */
export class ConfigurationStore {
  readonly path: string;
  readonly #fileSystem: ConfigurationFileSystem;
  readonly #platform: NodeJS.Platform;
  readonly #uniqueId: () => string;
  #current: ConfigurationSnapshot;
  #mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: ConfigurationStoreOptions = {}) {
    this.path = options.path ?? getConfigurationPath();
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#platform = options.platform ?? process.platform;
    this.#uniqueId = options.uniqueId ?? randomUUID;
    this.#current = snapshot(this.path, {
      classification: "missing",
      warning: null,
      configuration: DEFAULT_CONFIGURATION,
      persisted: null,
    });
  }

  get current(): ConfigurationSnapshot {
    return {
      ...this.#current,
      configuration: cloneConfiguration(this.#current.configuration),
    };
  }

  async load(): Promise<ConfigurationSnapshot> {
    const classified = await this.#readAndClassify();
    this.#current = snapshot(this.path, classified);
    return this.current;
  }

  mutate(mutation: ConfigurationMutation): Promise<MutationResult> {
    const operation = this.#mutationQueue.then(() => this.#mutate(mutation));
    this.#mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #readAndClassify(): Promise<ClassifiedConfiguration> {
    let stats: { isSymbolicLink(): boolean };
    try {
      stats = await this.#fileSystem.lstat(this.path);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        return {
          classification: "missing",
          warning: null,
          configuration: cloneConfiguration(DEFAULT_CONFIGURATION),
          persisted: null,
        };
      }
      return {
        classification: "unreadable",
        warning: "unreadable",
        configuration: cloneConfiguration(DEFAULT_CONFIGURATION),
        persisted: null,
      };
    }

    if (stats.isSymbolicLink()) {
      return {
        classification: "symlink",
        warning: "symlink",
        configuration: cloneConfiguration(DEFAULT_CONFIGURATION),
        persisted: null,
      };
    }

    let source: string;
    try {
      source = await this.#fileSystem.readFile(this.path, "utf8");
    } catch {
      return {
        classification: "unreadable",
        warning: "unreadable",
        configuration: cloneConfiguration(DEFAULT_CONFIGURATION),
        persisted: null,
      };
    }

    if (source.trim().length === 0) return malformedConfiguration();
    try {
      const parsed: unknown = JSON.parse(source);
      return classifyParsed(parsed);
    } catch {
      return malformedConfiguration();
    }
  }

  async #mutate(mutation: ConfigurationMutation): Promise<MutationResult> {
    const disk = await this.#readAndClassify();
    const validatedMutation = validateMutation(mutation);
    if (!validatedMutation.valid) return { ok: false, reason: "invalid-mutation" };

    if (
      disk.classification === "symlink" ||
      disk.classification === "unreadable" ||
      disk.classification === "unsupported-version"
    ) {
      return { ok: false, reason: "not-writable" };
    }

    const merged = applyMutation(disk, validatedMutation);
    const content = `${JSON.stringify(merged.persisted, null, 2)}\n`;
    const directory = dirname(this.path);
    const temporaryPath = join(directory, `.${CONFIG_FILE_NAME}.${this.#uniqueId()}.tmp`);
    let handle: ConfigurationFileHandle | undefined;

    try {
      await this.#fileSystem.mkdir(directory, {
        recursive: true,
        ...(this.#platform === "win32" ? {} : { mode: 0o700 }),
      });
      handle = await this.#fileSystem.open(
        temporaryPath,
        "wx",
        this.#platform === "win32" ? undefined : 0o600,
      );
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.#fileSystem.rename(temporaryPath, this.path);
    } catch {
      if (handle !== undefined) {
        try {
          await handle.close();
        } catch {
          // The original persistence failure determines the result.
        }
      }
      try {
        await this.#fileSystem.unlink(temporaryPath);
      } catch {
        // The temp may not exist; cleanup is best effort.
      }
      return { ok: false, reason: "write-failed" };
    }

    if (this.#platform !== "win32") {
      try {
        const directoryHandle = await this.#fileSystem.open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch {
        // Directory fsync is explicitly best effort.
      }
    }

    this.#current = snapshot(this.path, {
      classification: "valid",
      warning: null,
      configuration: merged.configuration,
      persisted: merged.persisted,
    });
    return { ok: true, configuration: cloneConfiguration(merged.configuration) };
  }
}
