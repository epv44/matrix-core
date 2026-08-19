import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "src", "agentsmith");
const outDir = path.join(root, "dist", "agentsmith");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function walk(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let copied = 0;
for (const file of walk(srcDir)) {
  if (!/\.(md|ya?ml)$/.test(file)) continue;
  const rel = path.relative(srcDir, file);
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(file, dest);
  copied++;
}
console.log(`[copy-assets] copied ${copied} review assets to dist/agentsmith`);

fs.cpSync(path.join(root, "src", "policy"), path.join(root, "dist", "policy"), { recursive: true });
console.log("[copy-assets] copied embedded policy assets to dist/policy");

const binEntries = new Set(Object.values(packageJson.bin ?? {}));
for (const relative of binEntries) {
  const entry = path.resolve(root, relative);
  fs.chmodSync(entry, 0o755);
}
console.log(`[copy-assets] marked ${binEntries.size} package bin entries executable`);
