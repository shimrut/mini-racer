// Scans `public/assets/cars/` and writes `game/car/generated-player-selectable-car-assets.js`. Run: `npm run generate:car-assets`
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const carsDir = join(repoRoot, "public", "assets", "cars");
const outFile = join(repoRoot, "game", "car", "generated-player-selectable-car-assets.js");

const STOCK_FILE = "mr_mr_red.webp";
const STOCK_PATH = `assets/cars/${STOCK_FILE}`;

const files = readdirSync(carsDir)
  .filter((f) => /^mr_.+\.webp$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

if (!files.includes(STOCK_FILE)) {
  console.error(`generate-player-car-assets: missing required stock car ${STOCK_FILE} in ${carsDir}`);
  process.exit(1);
}

const paths = files.map((f) => `assets/cars/${f}`);
const ordered = paths.includes(STOCK_PATH)
  ? [STOCK_PATH, ...paths.filter((p) => p !== STOCK_PATH)]
  : paths;

const body = [
  "// Auto-generated from `public/assets/cars/`; run `npm run generate:car-assets` instead of editing.",
  "",
  "export const GENERATED_PLAYER_SELECTABLE_CAR_ASSETS = Object.freeze([",
  ...ordered.map((p) => `  ${JSON.stringify(p)},`),
  "]);",
  "",
].join("\n");

writeFileSync(outFile, body, "utf8");
console.log(`generate-player-car-assets: wrote ${ordered.length} paths -> ${outFile}`);
