import { verifyAssets } from "./pipeline.js";

await verifyAssets({ reproduce: true });
console.log("Verified committed assets and pinned byte-identical regeneration.");
