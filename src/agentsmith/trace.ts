import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ReviewResult } from "../core/types.js";
import type { ReviewScope } from "./scope.js";
import type { EngineExecution } from "./engine-types.js";

export const TRACE_ENV = "MATRIXCORE_TRACE";
export const TRACE_SCHEMA_VERSION = 3;
export const TRACE_MAX_COUNT = 20;
export const TRACE_MAX_BYTES = 250 * 1024 * 1024;

export interface AgentSmithTrace {
  schemaVersion: 2 | 3;
  traceId: string;
  captureMode: "automatic-local" | "explicit-local";
  createdAt: string;
  packageVersion: string;
  root: string;
  version: string;
  profileHash?: string;
  strategyHash?: string;
  graphSnapshotHash?: string | null;
  scope: ReviewScope;
  deterministicReport: string;
  execution?: EngineExecution;
  result: ReviewResult;
  decisionProvenance: {
    publishedFindingIds: string[];
    rejectedCandidateIds: string[];
    likelyCandidateIds: string[];
    insufficientEvidenceCandidateIds: string[];
    aggregateRule: string;
    errors: string[];
  };
}

function traceTokens(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}
export function isAgentSmithTraceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const tokens = traceTokens(env[TRACE_ENV]);
  return !tokens.some((token) => ["0", "false", "none", "off"].includes(token));
}
export function tracesRoot(root: string): string {
  return path.join(root, ".quality", "traces", "agentsmith");
}
export function createTraceId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
}

function directorySize(target: string): number {
  try {
    return fs.readdirSync(target, { withFileTypes: true }).reduce((total, entry) => {
      const child = path.join(target, entry.name);
      return total + (entry.isDirectory() ? directorySize(child) : fs.statSync(child).size);
    }, 0);
  } catch {
    return 0;
  }
}

export function pruneAgentSmithTraces(
  root: string,
  limits: { maxCount?: number; maxBytes?: number } = {},
): { removed: string[]; retained: number; bytes: number } {
  const maxCount = Math.max(1, limits.maxCount ?? TRACE_MAX_COUNT);
  const maxBytes = Math.max(1, limits.maxBytes ?? TRACE_MAX_BYTES);
  const directory = tracesRoot(root);
  let entries: Array<{ id: string; path: string; modifiedMs: number; bytes: number }> = [];
  try {
    entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const target = path.join(directory, entry.name);
        return { id: entry.name, path: target, modifiedMs: fs.statSync(target).mtimeMs, bytes: directorySize(target) };
      })
      .sort((left, right) => right.modifiedMs - left.modifiedMs || right.id.localeCompare(left.id));
  } catch {
    return { removed: [], retained: 0, bytes: 0 };
  }
  const removed: string[] = [];
  let retained = 0;
  let bytes = 0;
  for (const entry of entries) {
    // Keep the newest trace even when a single unusually large trace exceeds the byte budget.
    if (retained === 0 || (retained < maxCount && bytes + entry.bytes <= maxBytes)) {
      retained += 1;
      bytes += entry.bytes;
      continue;
    }
    try {
      fs.rmSync(entry.path, { recursive: true, force: true });
      removed.push(entry.id);
    } catch {
      // Retention failure must not change the review decision.
    }
  }
  return { removed, retained, bytes };
}
export function writeAgentSmithTrace(
  root: string,
  input: Omit<AgentSmithTrace, "schemaVersion" | "traceId" | "captureMode" | "createdAt" | "root">,
): { traceId?: string; warning?: string } {
  if (!isAgentSmithTraceEnabled()) return {};
  const traceId = createTraceId();
  const directory = path.join(tracesRoot(root), traceId);
  const target = path.join(directory, "trace.json");
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const trace: AgentSmithTrace = {
      ...input,
      schemaVersion: TRACE_SCHEMA_VERSION,
      traceId,
      captureMode: traceTokens(process.env[TRACE_ENV]).some((token) => ["agentsmith", "all"].includes(token))
        ? "explicit-local"
        : "automatic-local",
      createdAt: new Date().toISOString(),
      root,
    };
    fs.writeFileSync(temporary, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
    pruneAgentSmithTraces(root);
    return { traceId };
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* best effort */
    }
    return { warning: `AgentSmith trace was not written: ${error instanceof Error ? error.message : String(error)}` };
  }
}
export function readAgentSmithTrace(root: string, traceId: string): AgentSmithTrace {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(traceId)) throw new Error(`Invalid trace id: ${traceId}`);
  const parsed = JSON.parse(
    fs.readFileSync(path.join(tracesRoot(root), traceId, "trace.json"), "utf8"),
  ) as AgentSmithTrace;
  if (![2, 3].includes(parsed.schemaVersion) || parsed.traceId !== traceId)
    throw new Error(`Unsupported or inconsistent AgentSmith trace: ${traceId}`);
  return parsed;
}
export function listAgentSmithTraces(root: string): AgentSmithTrace[] {
  try {
    return fs
      .readdirSync(tracesRoot(root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        try {
          return readAgentSmithTrace(root, entry.name);
        } catch {
          return null;
        }
      })
      .filter((trace): trace is AgentSmithTrace => trace !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch {
    return [];
  }
}
export function traceStatus(root: string) {
  const check = spawnSync("git", ["check-ignore", "-q", ".quality/"], { cwd: root });
  return {
    enabled: isAgentSmithTraceEnabled(),
    activation: `automatic; set ${TRACE_ENV}=off to disable`,
    directory: tracesRoot(root),
    gitIgnored: check.status === 0,
    uploadCapability: false,
    traceCount: listAgentSmithTraces(root).length,
    retention: { maxCount: TRACE_MAX_COUNT, maxBytes: TRACE_MAX_BYTES },
  };
}
