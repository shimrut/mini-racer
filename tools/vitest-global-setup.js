import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Ensures `game/car/generated-player-selectable-car-assets.js` matches
 * `public/assets/cars/` before tests run (even when invoking Vitest directly).
 */
export default function vitestGlobalSetup() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(root, "tools", "generate-player-car-assets.js");
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("generate-player-car-assets.js failed");
  }
}
