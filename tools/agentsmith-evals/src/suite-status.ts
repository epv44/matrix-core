import fs from "node:fs";
import path from "node:path";
import type { EvalProgressEvent } from "./eval.js";

export type SuiteRunState = "running" | "completed" | "failed" | "cancelled";

export interface SuiteStatusTier {
  tier: string;
  repetitions: number;
  deterministic: boolean;
  plannedRuns: number;
  completedRuns: number;
  failedRuns: number;
  status: "pending" | "running" | "completed" | "failed";
}

export interface SuiteRunStatus {
  schemaVersion: 1;
  reportKind: "agentsmith-eval-suite-status";
  runId: string;
  suite?: string;
  modelTarget?: "small" | "large";
  state: SuiteRunState;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  label: string | null;
  plannedRuns: number;
  completedRuns: number;
  failedRuns: number;
  remainingRuns: number;
  elapsedMs: number;
  current: {
    tier: string;
    caseId: string;
    mode: string;
    iteration: number;
  } | null;
  totals: {
    inputTokens: number;
    outputTokens: number;
    modelCalls: number;
  };
  tiers: SuiteStatusTier[];
  lastError: string | null;
  baselineError: string | null;
  output: string | null;
  htmlOutput: string | null;
  baselineOutput: string | null;
}

export interface SuiteStatusConfig {
  runId: string;
  suite?: string;
  modelTarget?: "small" | "large";
  label?: string;
  startedAt?: string;
  caseCount: number;
  modes: readonly string[];
  tiers: readonly { tier: string; repetitions: number; deterministic: boolean }[];
}

export function suiteStatusDirectory(root: string, runId: string): string {
  return path.join(root, ".quality", "evals", "suites", runId);
}

export function suiteStatusPath(root: string, runId: string): string {
  return path.join(suiteStatusDirectory(root, runId), "status.json");
}

export function createSuiteRunStatus(config: SuiteStatusConfig): SuiteRunStatus {
  const startedAt = config.startedAt ?? new Date().toISOString();
  const modes = config.modes.length * config.caseCount;
  const tiers = config.tiers.map((tier) => ({
    ...tier,
    plannedRuns: modes * tier.repetitions,
    completedRuns: 0,
    failedRuns: 0,
    status: "pending" as const,
  }));
  const plannedRuns = tiers.reduce((sum, tier) => sum + tier.plannedRuns, 0);
  return {
    schemaVersion: 1,
    reportKind: "agentsmith-eval-suite-status",
    runId: config.runId,
    suite: config.suite,
    modelTarget: config.modelTarget,
    state: "running",
    startedAt,
    updatedAt: startedAt,
    label: config.label ?? null,
    plannedRuns,
    completedRuns: 0,
    failedRuns: 0,
    remainingRuns: plannedRuns,
    elapsedMs: 0,
    current: null,
    totals: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
    tiers,
    lastError: null,
    baselineError: null,
    output: null,
    htmlOutput: null,
    baselineOutput: null,
  };
}

export function applySuiteProgress(status: SuiteRunStatus, event: EvalProgressEvent): SuiteRunStatus {
  const now = new Date();
  const tiers = status.tiers.map((tier) => {
    if (tier.tier !== event.tier) return tier;
    const completedRuns = tier.completedRuns + 1;
    const failedRuns = tier.failedRuns + (event.status === "error" ? 1 : 0);
    return {
      ...tier,
      completedRuns,
      failedRuns,
      status: (completedRuns >= tier.plannedRuns
        ? failedRuns
          ? "failed"
          : "completed"
        : "running") as SuiteStatusTier["status"],
    };
  });
  const completedRuns = status.completedRuns + 1;
  return {
    ...status,
    updatedAt: now.toISOString(),
    elapsedMs: now.getTime() - Date.parse(status.startedAt),
    completedRuns,
    failedRuns: status.failedRuns + (event.status === "error" ? 1 : 0),
    remainingRuns: Math.max(0, status.plannedRuns - completedRuns),
    current: { tier: event.tier, caseId: event.caseId, mode: event.mode, iteration: event.iteration },
    totals: {
      inputTokens: status.totals.inputTokens + event.inputTokens,
      outputTokens: status.totals.outputTokens + event.outputTokens,
      modelCalls: status.totals.modelCalls + event.modelCalls,
    },
    tiers,
  };
}

export function finishSuiteRunStatus(
  status: SuiteRunStatus,
  state: Exclude<SuiteRunState, "running">,
  details: Partial<Pick<SuiteRunStatus, "lastError" | "baselineError" | "output" | "htmlOutput" | "baselineOutput">> = {},
): SuiteRunStatus {
  const now = new Date();
  return {
    ...status,
    ...details,
    state,
    updatedAt: now.toISOString(),
    completedAt: now.toISOString(),
    elapsedMs: now.getTime() - Date.parse(status.startedAt),
  };
}

export function writeSuiteRunStatus(file: string, status: SuiteRunStatus): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

export function readSuiteRunStatus(file: string): SuiteRunStatus {
  return JSON.parse(fs.readFileSync(file, "utf8")) as SuiteRunStatus;
}

export function findLatestSuiteStatus(root: string): { path: string; status: SuiteRunStatus } | null {
  const directory = path.join(root, ".quality", "evals", "suites");
  if (!fs.existsSync(directory)) return null;
  const candidates = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name, "status.json"))
    .filter((file) => fs.existsSync(file))
    .map((file) => ({ path: file, status: readSuiteRunStatus(file) }))
    .sort((left, right) => Date.parse(right.status.updatedAt) - Date.parse(left.status.updatedAt));
  return candidates[0] ?? null;
}
