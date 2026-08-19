import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION, GATE_STORE_DIR } from "./meta.js";
import type { EngineRuntimeIdentity } from "./types.js";
import crypto from "node:crypto";

export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  return fs.realpathSync(absolute);
}

export function engineRuntimeIdentity(executable = process.argv[1]): EngineRuntimeIdentity {
  const modulePath = fileURLToPath(import.meta.url);
  const packageRoot = canonicalPath(path.resolve(path.dirname(modulePath), "../.."));
  let executablePath = modulePath;
  if (executable) {
    try {
      executablePath = canonicalPath(executable);
    } catch {
      executablePath = path.resolve(executable);
    }
  }
  return { version: ENGINE_VERSION, executablePath, packageRoot };
}

export function recordEngineRuntime(root: string, adapter: "mcp" | "hook" | "cli"): EngineRuntimeIdentity {
  const canonicalRoot = canonicalPath(root);
  const runtime = engineRuntimeIdentity();
  const directory = path.join(canonicalRoot, GATE_STORE_DIR);
  const target = path.join(directory, `${adapter}-runtime.json`);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, adapter, recordedAt: new Date().toISOString(), ...runtime }, null, 2)}\n`,
  );
  fs.renameSync(temporary, target);
  return runtime;
}
