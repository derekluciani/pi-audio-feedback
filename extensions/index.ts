import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Loads the audio-feedback package without starting resources during extension discovery.
 * Runtime behavior is added by later implementation stages and begins only in session hooks.
 */
export default function audioFeedbackExtension(pi: ExtensionAPI): void {
  // Referencing the injected API makes this a valid, side-effect-free Pi extension factory.
  void pi;
}
