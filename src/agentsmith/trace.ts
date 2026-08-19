import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ReviewResult } from "../core/types.js";
import type { ReviewScope } from "./scope.js";
import type { EngineExecution } from "./engine-types.js";

export const TRACE_ENV = "MATRIXCORE_TRACE";
export const TRACE_SCHEMA_VERSION = 2;

export interface AgentSmithTrace {
  schemaVersion: 2;
  traceId: string;
  captureMode: "explicit-local";
  createdAt: string;
  packageVersion: string;
  root: string;
  version: string;
  profileHash?: string;
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
  return tokens.includes("agentsmith") || tokens.includes("all");
}
export function tracesRoot(root: string): string {
  return path.join(root, ".quality", "traces", "agentsmith");
}
export function createTraceId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
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
      schemaVersion: 2,
      traceId,
      captureMode: "explicit-local",
      createdAt: new Date().toISOString(),
      root,
    };
    fs.writeFileSync(temporary, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
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
  if (parsed.schemaVersion !== 2 || parsed.traceId !== traceId)
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
    activation: `${TRACE_ENV}=agentsmith`,
    directory: tracesRoot(root),
    gitIgnored: check.status === 0,
    uploadCapability: false,
    traceCount: listAgentSmithTraces(root).length,
  };
}
