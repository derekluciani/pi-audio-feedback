import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => "/managed/pi-agent",
}));

type PackageManifest = {
  name?: unknown;
  type?: unknown;
  engines?: { node?: unknown };
  keywords?: unknown;
  peerDependencies?: Record<string, unknown>;
  pi?: {
    extensions?: unknown;
    compatibility?: Record<string, unknown>;
  };
};

async function readPackageManifest(): Promise<PackageManifest> {
  const source = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const value: unknown = JSON.parse(source);

  if (typeof value !== "object" || value === null) {
    throw new TypeError("package.json must contain an object");
  }

  return value;
}

describe("release foundation", () => {
  it("exports a loadable Pi extension factory through the supplied public Pi API", async () => {
    const { default: audioFeedbackExtension } = await import("../extensions/index.js");

    expect(audioFeedbackExtension).toBeTypeOf("function");
    expect(audioFeedbackExtension).toHaveLength(1);
  });

  it("declares package and compatibility metadata", async () => {
    const manifest = await readPackageManifest();

    expect(manifest.name).toBe("pi-audio-feedback");
    expect(manifest.type).toBe("module");
    expect(manifest.engines?.node).toBe(">=20");
    expect(manifest.keywords).toEqual(["pi-package"]);
    expect(manifest.pi?.extensions).toEqual(["./extensions"]);
    expect(manifest.pi?.compatibility?.["@earendil-works/pi-coding-agent"]).toBe(">=0.80.6 <1.0.0");
    expect(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
  });

  it("keeps the Windows player helper fixed", async () => {
    const script = await readFile(new URL("../scripts/play-wav.ps1", import.meta.url), "utf8");

    expect(script).toBe(
      "param([Parameter(Mandatory = $true)][string]$Path)\n" +
        "$player = [System.Media.SoundPlayer]::new($Path)\n" +
        "$player.Load()\n" +
        "$player.PlaySync()\n",
    );
  });
});
