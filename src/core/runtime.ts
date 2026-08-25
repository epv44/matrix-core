import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_VERSION, GATE_STORE_DIR } from "./meta.js";
import type { EngineRuntimeIdentity } from "./types.js";
import os from "node:os";
import { atomicWriteFile } from "./filesystem.js";
import { isProcessAlive } from "./process.js";

const runtimeStartedAt = new Date().toISOString();
const mcpRuntimeFiles = new Set<string>();

interface McpRuntimeRecord extends EngineRuntimeIdentity {
  schemaVersion: 2;
  adapter: "mcp";
  recordedAt: string;
  startedAt: string;
  pid: number;
  parentPid: number;
  hostname: string;
  root: string;
}

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
  atomicWriteFile(
    target,
    `${JSON.stringify({ schemaVersion: 2, adapter, recordedAt: new Date().toISOString(), pid: process.pid, parentPid: process.ppid, ...runtime }, null, 2)}\n`,
  );
  if (adapter === "mcp") recordMcpProcessRuntime(canonicalRoot, runtime);
  return runtime;
}

function recordMcpProcessRuntime(root: string, runtime: EngineRuntimeIdentity): void {
  const directory = path.join(root, GATE_STORE_DIR, "mcp-runtime");
  const target = path.join(directory, `${process.pid}.json`);
  const record: McpRuntimeRecord = {
    schemaVersion: 2,
    adapter: "mcp",
    recordedAt: new Date().toISOString(),
    startedAt: runtimeStartedAt,
    pid: process.pid,
    parentPid: process.ppid,
    hostname: os.hostname(),
    root,
    ...runtime,
  };
  atomicWriteFile(target, `${JSON.stringify(record, null, 2)}\n`);
  mcpRuntimeFiles.add(target);
}

export function cleanupMcpRuntimeRecords(): void {
  for (const target of mcpRuntimeFiles) {
    try {
      fs.unlinkSync(target);
    } catch {}
  }
  mcpRuntimeFiles.clear();
}

export function mcpRuntimeWarnings(root: string): string[] {
  const directory = path.join(canonicalPath(root), GATE_STORE_DIR, "mcp-runtime");
  let records: McpRuntimeRecord[] = [];
  try {
    records = fs
      .readdirSync(directory)
      .filter((entry) => entry.endsWith(".json"))
      .flatMap((entry) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(directory, entry), "utf8")) as McpRuntimeRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
  const local = records.filter((record) => record.hostname === os.hostname());
  const stale = local.filter((record) => !isProcessAlive(record.pid));
  const live = local.filter(
    (record) => isProcessAlive(record.pid) && record.packageRoot === engineRuntimeIdentity().packageRoot,
  );
  const liveByParent = new Map<number, number>();
  for (const record of live) liveByParent.set(record.parentPid, (liveByParent.get(record.parentPid) ?? 0) + 1);
  const largestSiblingGroup = Math.max(0, ...liveByParent.values());
  const warnings: string[] = [];
  if (stale.length > 0)
    warnings.push(`${stale.length} stale MatrixCore MCP runtime record${stale.length === 1 ? "" : "s"} detected`);
  if (largestSiblingGroup > 5)
    warnings.push(
      `${largestSiblingGroup} live MatrixCore MCP processes share one host parent; restart the Cline MCP host if old sessions are no longer needed`,
    );
  return warnings;
}
