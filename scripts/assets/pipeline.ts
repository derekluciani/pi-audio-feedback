import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import type { SoundDefinition } from "@web-kits/audio";

import { EVENT_SOUND_MAPPING, THEMES, type LogicalEvent, type Theme } from "./mapping.js";

const require = createRequire(import.meta.url);
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PATCH_MANIFEST_PATH = join(PROJECT_ROOT, "assets/patches/manifest.json");
const WAV_ROOT = join(PROJECT_ROOT, "assets/wav");
const WAV_MANIFEST_PATH = join(WAV_ROOT, "manifest.json");
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_RENDERER = {
  webKitsAudioVersion: "0.1.0",
  nodeWebAudioApiVersion: "1.0.9",
  sampleRateHz: 48_000,
  channels: 1,
  pcmBitDepth: 16,
  minimumDurationMs: 200,
  tailMs: 750,
  fadeOutMs: 5,
  normalization: "none",
} as const;
const EXPECTED_PROVENANCE = {
  repository: "https://github.com/derekluciani/pi-audio-feedback.git",
  ref: "e2c768728106736413fb4ff725b20303afbe9a06",
  upstreamCatalog: "https://audio.raphaelsalaja.com/library",
} as const;
const EXPECTED_THEME_INPUTS = {
  core: {
    source: "assets/patches/core.json",
    sha256: "b9702e7cc9e018cbd42736ece94d47540697ac17e675c2d531c2db40ffa3ddfb",
  },
  retro: {
    source: "assets/patches/retro.json",
    sha256: "134013b63261d50c2a24049e758f0346e1f9f474de2c6c9c1cdb33db6d20b2fc",
  },
  organic: {
    source: "assets/patches/organic.json",
    sha256: "d67d124f70feefd091ca0b5771e32768f3fef706824ef2f1cb09b7d9eb6f10a0",
  },
  soft: {
    source: "assets/patches/soft.json",
    sha256: "c76ff281d8023009aa7d1b37ef1c46e3944b310634d6d0988242371a0b0c9b98",
  },
} as const;

type Patch = { name: string; sounds: Record<string, SoundDefinition> };
type AssetManifest = { version: 1; files: Record<string, string> };
type GeneratedAsset = { path: string; bytes: Uint8Array };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(source: string, path: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}`, { cause: error });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactObject(
  actual: unknown,
  expected: Readonly<Record<string, unknown>>,
  context: string,
): asserts actual is Record<string, unknown> {
  if (!isObject(actual)) {
    throw new TypeError(`${context} must be an object`);
  }
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${context} does not match the approved release input`);
  }
}

async function readAndValidatePatchManifest(): Promise<typeof EXPECTED_THEME_INPUTS> {
  const raw = await readFile(PATCH_MANIFEST_PATH, "utf8");
  const value = parseJson(raw, PATCH_MANIFEST_PATH);
  if (!isObject(value)) {
    throw new TypeError("Patch manifest must contain an object");
  }
  assertExactObject(value.renderer, EXPECTED_RENDERER, "Patch manifest renderer");
  assertExactObject(value.provenance, EXPECTED_PROVENANCE, "Patch manifest provenance");
  assertExactObject(value.themes, EXPECTED_THEME_INPUTS, "Patch manifest themes");
  return EXPECTED_THEME_INPUTS;
}

let patchValidatorPromise: Promise<ValidateFunction<Patch>> | undefined;

async function getPatchValidator(): Promise<ValidateFunction<Patch>> {
  patchValidatorPromise ??= (async () => {
    const packagePath = require.resolve("@web-kits/audio/package.json");
    const schemaUrl = new URL("./schemas/patch.schema.json", pathToFileURL(packagePath));
    const schema = parseJson(await readFile(schemaUrl, "utf8"), fileURLToPath(schemaUrl));
    if (!isObject(schema)) {
      throw new TypeError("@web-kits/audio patch schema must contain an object");
    }
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    return ajv.compile<Patch>(schema);
  })();
  return patchValidatorPromise;
}

function resolveCommittedInput(source: string): string {
  const absolutePath = resolve(PROJECT_ROOT, source);
  const relativePath = relative(PROJECT_ROOT, absolutePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
    throw new Error(`Patch source escapes the repository: ${source}`);
  }
  return absolutePath;
}

async function readPatches(): Promise<Record<Theme, Patch>> {
  const inputs = await readAndValidatePatchManifest();
  const validatePatch = await getPatchValidator();
  const entries = await Promise.all(
    THEMES.map(async (theme): Promise<readonly [Theme, Patch]> => {
      const input = inputs[theme];
      const sourcePath = resolveCommittedInput(input.source);
      const bytes = await readFile(sourcePath);
      const actualChecksum = sha256(bytes);
      if (actualChecksum !== input.sha256) {
        throw new Error(
          `Patch checksum mismatch for theme=${theme} patch=${input.source}: expected ${input.sha256}, received ${actualChecksum}`,
        );
      }
      const value = parseJson(bytes.toString("utf8"), sourcePath);
      if (!validatePatch(value)) {
        const details = validatePatch.errors?.map((error) => error.message).join(", ") ?? "unknown";
        throw new Error(
          `Invalid patch schema for theme=${theme} patch=${input.source}: ${details}`,
        );
      }
      return [theme, value] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<Theme, Patch>;
}

function mappedSounds(patches: Record<Theme, Patch>): Record<Theme, Map<string, SoundDefinition>> {
  const byTheme = Object.fromEntries(
    THEMES.map((theme) => [theme, new Map<string, SoundDefinition>()]),
  ) as Record<Theme, Map<string, SoundDefinition>>;
  const outputPaths = new Map<string, string>();

  for (const [logicalEvent, mapping] of Object.entries(EVENT_SOUND_MAPPING) as [
    LogicalEvent,
    (typeof EVENT_SOUND_MAPPING)[LogicalEvent],
  ][]) {
    for (const theme of THEMES) {
      const patchName = mapping[theme];
      const definition = patches[theme].sounds[patchName];
      if (definition === undefined) {
        throw new Error(
          `Missing mapped sound: theme=${theme} logical-event=${logicalEvent} patch-name=${patchName}`,
        );
      }
      const outputPath = `assets/wav/${theme}/${patchName}.wav`;
      const priorPatchName = outputPaths.get(outputPath);
      if (priorPatchName !== undefined && priorPatchName !== patchName) {
        throw new Error(
          `Duplicate output path: theme=${theme} logical-event=${logicalEvent} patch-name=${patchName} path=${outputPath}`,
        );
      }
      outputPaths.set(outputPath, patchName);
      byTheme[theme].set(patchName, definition);
    }
  }
  return byTheme;
}

function layerDurationSeconds(definition: SoundDefinition): number {
  const layers = "layers" in definition ? definition.layers : [definition];
  return Math.max(
    ...layers.map((layer) => {
      const delay = layer.delay ?? 0;
      if (layer.envelope === undefined) {
        return delay + 0.5;
      }
      return (
        delay + (layer.envelope.attack ?? 0) + layer.envelope.decay + (layer.envelope.release ?? 0)
      );
    }),
  );
}

export function calculateDurationMs(definition: SoundDefinition): number {
  return Math.max(
    EXPECTED_RENDERER.minimumDurationMs,
    Math.ceil(layerDurationSeconds(definition) * 1_000 + EXPECTED_RENDERER.tailMs),
  );
}

async function installWebAudioGlobals(): Promise<void> {
  const implementation = await import("node-web-audio-api");
  for (const [name, value] of Object.entries(implementation)) {
    if (/^[A-Z]/u.test(name)) {
      Reflect.set(globalThis, name, value);
    }
  }
}

function seededRandom(seedText: string): () => number {
  let state = createHash("sha256").update(seedText).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

function applyFinalFade(buffer: AudioBuffer): void {
  const fadeFrames = Math.min(
    buffer.length,
    Math.round((EXPECTED_RENDERER.fadeOutMs / 1_000) * buffer.sampleRate),
  );
  const samples = new Float32Array(buffer.length);
  buffer.copyFromChannel(samples, 0);
  const denominator = Math.max(1, fadeFrames - 1);
  for (let index = 0; index < fadeFrames; index += 1) {
    const sampleIndex = buffer.length - fadeFrames + index;
    samples[sampleIndex] = (samples[sampleIndex] ?? 0) * ((fadeFrames - 1 - index) / denominator);
  }
  buffer.copyToChannel(samples, 0);
}

function encodePcm16Wav(buffer: AudioBuffer, context: string): Uint8Array {
  const bytesPerSample = EXPECTED_RENDERER.pcmBitDepth / 8;
  const blockAlign = buffer.numberOfChannels * bytesPerSample;
  const dataSize = buffer.length * blockAlign;
  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, buffer.numberOfChannels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, EXPECTED_RENDERER.pcmBitDepth, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) =>
    buffer.getChannelData(channel),
  );
  let offset = 44;
  for (let frame = 0; frame < buffer.length; frame += 1) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      const sample = channels[channel]?.[frame];
      if (sample === undefined || !Number.isFinite(sample) || sample < -1 || sample > 1) {
        throw new RangeError(
          `Rendered sample is outside signed-16 PCM range: ${context} frame=${String(frame)} channel=${String(channel)} value=${String(sample)}`,
        );
      }
      const pcmSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, pcmSample, true);
      offset += bytesPerSample;
    }
  }
  return bytes;
}

function assertRepresentableSamples(buffer: AudioBuffer, context: string): void {
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let frame = 0; frame < samples.length; frame += 1) {
      const sample = samples[frame];
      if (sample === undefined || !Number.isFinite(sample) || sample < -1 || sample > 1) {
        throw new RangeError(
          `Rendered sample is outside signed-16 PCM range: ${context} frame=${String(frame)} channel=${String(channel)} value=${String(sample)}`,
        );
      }
    }
  }
}

async function renderAssets(): Promise<GeneratedAsset[]> {
  const patches = await readPatches();
  const sounds = mappedSounds(patches);
  await installWebAudioGlobals();
  const { renderToBuffer } = await import("@web-kits/audio");
  const assets: GeneratedAsset[] = [];

  for (const theme of THEMES) {
    for (const [patchName, definition] of [...sounds[theme]].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const originalRandom = Math.random;
      let buffer: AudioBuffer;
      try {
        Math.random = seededRandom(`${theme}/${patchName}`);
        buffer = await renderToBuffer(definition, {
          duration: calculateDurationMs(definition) / 1_000,
          sampleRate: EXPECTED_RENDERER.sampleRateHz,
          numberOfChannels: EXPECTED_RENDERER.channels,
        });
      } finally {
        Math.random = originalRandom;
      }
      const context = `theme=${theme} patch-name=${patchName}`;
      assertRepresentableSamples(buffer, context);
      applyFinalFade(buffer);
      assets.push({
        path: `assets/wav/${theme}/${patchName}.wav`,
        bytes: encodePcm16Wav(buffer, context),
      });
    }
  }
  return assets;
}

function serializeManifest(assets: readonly GeneratedAsset[]): string {
  const files = Object.fromEntries(assets.map((asset) => [asset.path, sha256(asset.bytes)]));
  return `${JSON.stringify({ version: 1, files } satisfies AssetManifest, undefined, 2)}\n`;
}

export async function generateAssets(outputRoot = PROJECT_ROOT): Promise<void> {
  const assets = await renderAssets();
  const wavRoot = join(outputRoot, "assets/wav");
  await rm(wavRoot, { recursive: true, force: true });
  for (const asset of assets) {
    const outputPath = join(outputRoot, asset.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, asset.bytes);
  }
  await writeFile(join(wavRoot, "manifest.json"), serializeManifest(assets));
}

function validateWav(bytes: Uint8Array, path: string): void {
  if (bytes.byteLength < 44) {
    throw new Error(`WAV is too short: ${path}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (text(0, 4) !== "RIFF" || text(8, 4) !== "WAVE" || text(12, 4) !== "fmt ") {
    throw new Error(`Invalid RIFF/WAVE header: ${path}`);
  }
  if (
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== EXPECTED_RENDERER.channels ||
    view.getUint32(24, true) !== EXPECTED_RENDERER.sampleRateHz ||
    view.getUint16(34, true) !== EXPECTED_RENDERER.pcmBitDepth ||
    text(36, 4) !== "data"
  ) {
    throw new Error(`Invalid WAV PCM format: ${path}`);
  }
  if (
    view.getUint32(4, true) + 8 !== bytes.byteLength ||
    view.getUint32(40, true) + 44 !== bytes.byteLength
  ) {
    throw new Error(`Invalid WAV chunk sizes: ${path}`);
  }
}

function parseAssetManifest(value: unknown): AssetManifest {
  if (!isObject(value) || value.version !== 1 || !isObject(value.files)) {
    throw new TypeError("WAV manifest must contain version 1 and a files object");
  }
  for (const [path, checksum] of Object.entries(value.files)) {
    if (
      !path.startsWith("assets/wav/") ||
      !path.endsWith(".wav") ||
      !SHA256_PATTERN.test(String(checksum))
    ) {
      throw new Error(`Invalid WAV manifest entry: ${path}`);
    }
  }
  return {
    version: 1,
    files: Object.fromEntries(
      Object.entries(value.files).map(([path, sum]) => [path, String(sum)]),
    ),
  };
}

async function listRelativeFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        return listRelativeFiles(join(directory, entry.name), `${relativePath}/`);
      }
      return [relativePath];
    }),
  );
  return files.flat().sort();
}

export type AssetVerificationOptions = {
  /** Regenerate WAVs and require pinned-renderer byte identity. Pinned CI must enable this. */
  reproduce?: boolean;
};

function expectedAssetPaths(patches: Record<Theme, Patch>): string[] {
  const sounds = mappedSounds(patches);
  return THEMES.flatMap((theme) =>
    [...sounds[theme].keys()]
      .sort((left, right) => left.localeCompare(right))
      .map((patchName) => `assets/wav/${theme}/${patchName}.wav`),
  );
}

/**
 * Validate authoritative patch inputs and committed WAV artifacts on any supported host.
 * Rendering is opt-in because byte identity is guaranteed only by the pinned Linux toolchain.
 */
export async function verifyAssets(options: AssetVerificationOptions = {}): Promise<void> {
  const patches = await readPatches();
  const expectedPaths = expectedAssetPaths(patches);
  const rawManifest = await readFile(WAV_MANIFEST_PATH, "utf8");
  const manifest = parseAssetManifest(parseJson(rawManifest, WAV_MANIFEST_PATH));
  const expectedDiskPaths = [
    "manifest.json",
    ...expectedPaths.map((path) => path.slice("assets/wav/".length)),
  ].sort();
  const diskPaths = await listRelativeFiles(WAV_ROOT);
  if (!isDeepStrictEqual(diskPaths, expectedDiskPaths)) {
    throw new Error("Committed WAV directory contains missing or unexpected files");
  }
  const manifestPaths = Object.keys(manifest.files).sort();
  if (!isDeepStrictEqual(manifestPaths, [...expectedPaths].sort())) {
    throw new Error("WAV manifest paths do not exactly match the approved mapping outputs");
  }

  const committedAssets: GeneratedAsset[] = [];
  for (const path of expectedPaths) {
    const committed = await readFile(join(PROJECT_ROOT, path));
    validateWav(committed, path);
    const checksum = sha256(committed);
    if (checksum !== manifest.files[path]) {
      throw new Error(`WAV checksum mismatch: ${path}`);
    }
    committedAssets.push({ path, bytes: committed });
  }
  if (rawManifest !== serializeManifest(committedAssets)) {
    throw new Error("WAV manifest is not in canonical form or does not match committed WAVs");
  }

  if (options.reproduce !== true) {
    return;
  }

  const regeneratedAssets = await renderAssets();
  if (rawManifest !== serializeManifest(regeneratedAssets)) {
    throw new Error("WAV manifest is not byte-identical to pinned deterministic regeneration");
  }
  for (const regenerated of regeneratedAssets) {
    const committed = committedAssets.find((asset) => asset.path === regenerated.path);
    if (committed === undefined || !Buffer.from(committed.bytes).equals(regenerated.bytes)) {
      throw new Error(
        `WAV is not byte-identical to pinned deterministic regeneration: ${regenerated.path}`,
      );
    }
  }
}
