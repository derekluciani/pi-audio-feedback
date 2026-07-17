import { readFile } from "node:fs/promises";

import type { SoundDefinition } from "@web-kits/audio";
import { describe, expect, it } from "vitest";

import { EVENT_SOUND_MAPPING, THEMES } from "../scripts/assets/mapping.js";
import { calculateDurationMs, verifyAssets } from "../scripts/assets/pipeline.js";

const EXPECTED_PATCH_CHECKSUMS = {
  core: "b9702e7cc9e018cbd42736ece94d47540697ac17e675c2d531c2db40ffa3ddfb",
  retro: "134013b63261d50c2a24049e758f0346e1f9f474de2c6c9c1cdb33db6d20b2fc",
  organic: "d67d124f70feefd091ca0b5771e32768f3fef706824ef2f1cb09b7d9eb6f10a0",
  soft: "c76ff281d8023009aa7d1b37ef1c46e3944b310634d6d0988242371a0b0c9b98",
} as const;

function objectValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) {
    throw new TypeError(`Expected object property: ${key}`);
  }
  return Object.fromEntries(Object.entries(value))[key];
}

describe("deterministic asset pipeline", () => {
  it("pins renderer settings and immutable patch provenance", async () => {
    const source = await readFile(
      new URL("../assets/patches/manifest.json", import.meta.url),
      "utf8",
    );
    const manifest: unknown = JSON.parse(source);
    const renderer = objectValue(manifest, "renderer");
    const provenance = objectValue(manifest, "provenance");
    const themes = objectValue(manifest, "themes");

    expect(renderer).toEqual({
      webKitsAudioVersion: "0.1.0",
      nodeWebAudioApiVersion: "1.0.9",
      sampleRateHz: 48_000,
      channels: 1,
      pcmBitDepth: 16,
      minimumDurationMs: 200,
      tailMs: 750,
      fadeOutMs: 5,
      normalization: "none",
    });
    expect(provenance).toEqual({
      repository: "https://github.com/derekluciani/pi-audio-feedback.git",
      ref: "e2c768728106736413fb4ff725b20303afbe9a06",
      upstreamCatalog: "https://audio.raphaelsalaja.com/library",
    });
    for (const theme of THEMES) {
      expect(objectValue(objectValue(themes, theme), "sha256")).toBe(
        EXPECTED_PATCH_CHECKSUMS[theme],
      );
    }
  });

  it("contains every approved event-to-theme mapping", () => {
    expect(EVENT_SOUND_MAPPING).toMatchSnapshot();
  });

  it("uses maximum layer delay plus ADSR duration and the fixed tail", () => {
    const definition: SoundDefinition = {
      layers: [
        {
          source: { type: "sine", frequency: 440 },
          delay: 0.4,
          envelope: { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 },
        },
        {
          source: { type: "sine", frequency: 880 },
          envelope: { decay: 0.1 },
        },
      ],
    };

    expect(calculateDurationMs(definition)).toBe(1_750);
  });

  it("verifies committed headers, mapped paths, and checksums without regeneration", async () => {
    await expect(verifyAssets()).resolves.toBeUndefined();
  });

  it("keeps byte-identical regeneration explicit in pinned CI", async () => {
    const packageSource = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const packageManifest: unknown = JSON.parse(packageSource);
    const scripts = objectValue(packageManifest, "scripts");
    expect(objectValue(scripts, "assets:verify")).toBe("tsx scripts/assets/verify.ts");
    expect(objectValue(scripts, "assets:verify:reproduce")).toBe(
      "tsx scripts/assets/verify-reproduction.ts",
    );

    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("Deterministic assets (Ubuntu 24.04, Node 22.23.1)");
    expect(workflow).toContain("node-version: 22.23.1");
    expect(workflow).toContain("npm run assets:verify:reproduce");
  });
});
