import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist");

if (path.dirname(outDir) !== root || path.basename(outDir) !== "dist") {
  throw new Error(`Refusing to clean unexpected output directory: ${outDir}`);
}

fs.rmSync(outDir, { recursive: true, force: true });
