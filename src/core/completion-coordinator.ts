import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMPLETION_LOCK_FILE, COMPLETION_RESULT_FILE, qualityStorePath } from "./meta.js";
import { computeWorkspaceVersion } from "./version.js";
import { resolveConfig } from "./config-resolver.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import type { QualityCompletionResult } from "./types.js";
import { atomicWriteFile, readJsonFile } from "./filesystem.js";
import { isProcessAlive } from "./process.js";

interface CompletionIdentity {
  repositoryHash: string;
  policyHash: string;
}

interface CompletionLock {
  schemaVersion: 1;
  runId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  updatedAt: string;
  leaseUntil: string;
  identity: CompletionIdentity;
}

interface StoredCompletionResult {
  schemaVersion: 1;
  runId: string;
  identity: CompletionIdentity;
  status: "COMPLETED" | "ERROR";
  completedAt: string;
  result?: QualityCompletionResult;
  error?: string;
}

const localRuns = new Map<string, Promise<QualityCompletionResult>>();

function identity(root: string): CompletionIdentity {
  const resolved = resolveConfig({ cwd: root });
  return {
    repositoryHash: computeWorkspaceVersion(root),
    policyHash: resolvePolicyForConfig(resolved).policyHash,
  };
}

function sameIdentity(left: CompletionIdentity, right: CompletionIdentity): boolean {
  return left.repositoryHash === right.repositoryHash && left.policyHash === right.policyHash;
}

function atomicWrite(file: string, value: unknown): void {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function appendEvent(root: string, event: Record<string, unknown>): void {
  try {
    const file = qualityStorePath(root, "completion-events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
  } catch {}
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Completion cancelled"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Completion cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function coordinatedRun(
  root: string,
  signal: AbortSignal | undefined,
  execute: () => Promise<QualityCompletionResult>,
): Promise<QualityCompletionResult> {
  const requestedIdentity = identity(root);
  const lockPath = qualityStorePath(root, COMPLETION_LOCK_FILE);
  const resultPath = qualityStorePath(root, COMPLETION_RESULT_FILE);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    if (signal?.aborted) throw signal.reason ?? new Error("Completion cancelled");
    let descriptor: number;
    try {
      descriptor = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const active = readJsonFile<CompletionLock>(lockPath);
      const expired = active ? Date.parse(active.leaseUntil) <= Date.now() : false;
      const dead = active ? active.hostname === os.hostname() && !isProcessAlive(active.pid) : false;
      let malformedAndStale = false;
      if (!active) {
        try {
          malformedAndStale = Date.now() - fs.statSync(lockPath).mtimeMs > 60_000;
        } catch {}
      }
      if ((active && (expired || dead)) || malformedAndStale) {
        const latest = readJsonFile<CompletionLock>(lockPath);
        if ((active && latest?.runId === active.runId) || (!active && latest === null)) {
          fs.unlinkSync(lockPath);
          appendEvent(root, {
            type: "stale_lock_recovered",
            runId: active?.runId ?? null,
            pid: active?.pid ?? null,
          });
          continue;
        }
      }
      const joinedRunId = active?.runId;
      appendEvent(root, { type: "run_joined", runId: joinedRunId ?? null, pid: process.pid });
      while (fs.existsSync(lockPath)) await wait(100, signal);
      const completed = readJsonFile<StoredCompletionResult>(resultPath);
      if (completed && completed.runId === joinedRunId && sameIdentity(completed.identity, requestedIdentity)) {
        if (completed.status === "COMPLETED" && completed.result) return completed.result;
        throw new Error(completed.error ?? "Joined completion run failed");
      }
      continue;
    }

    const runId = crypto.randomUUID();
    const acquiredIdentity = identity(root);
    const resolved = resolveConfig({ cwd: root });
    const duration = Math.max(60_000, resolved.config.agentsmith?.maxDurationMs ?? 1_800_000) + 60_000;
    const startedAt = new Date().toISOString();
    let lock: CompletionLock = {
      schemaVersion: 1,
      runId,
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
      updatedAt: startedAt,
      leaseUntil: new Date(Date.now() + duration).toISOString(),
      identity: acquiredIdentity,
    };
    const writeLock = () => {
      lock = {
        ...lock,
        updatedAt: new Date().toISOString(),
        leaseUntil: new Date(Date.now() + duration).toISOString(),
      };
      fs.ftruncateSync(descriptor, 0);
      fs.writeSync(descriptor, `${JSON.stringify(lock, null, 2)}\n`, 0, "utf8");
      fs.fsyncSync(descriptor);
    };
    writeLock();
    const heartbeat = setInterval(writeLock, 5000);
    heartbeat.unref();
    appendEvent(root, { type: "run_started", runId, pid: process.pid, ...acquiredIdentity });
    try {
      const result = await execute();
      const stored: StoredCompletionResult = {
        schemaVersion: 1,
        runId,
        identity: acquiredIdentity,
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
        result,
      };
      atomicWrite(resultPath, stored);
      appendEvent(root, {
        type: "run_completed",
        runId,
        result: result.completionAllowed ? "PASS" : result.gate.status === "FAIL" ? "REJECT" : "ERROR",
      });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      atomicWrite(resultPath, {
        schemaVersion: 1,
        runId,
        identity: acquiredIdentity,
        status: "ERROR",
        completedAt: new Date().toISOString(),
        error: message,
      } satisfies StoredCompletionResult);
      appendEvent(root, { type: "run_error", runId, error: message });
      throw error;
    } finally {
      clearInterval(heartbeat);
      fs.closeSync(descriptor);
      const current = readJsonFile<CompletionLock>(lockPath);
      if (current?.runId === runId) fs.unlinkSync(lockPath);
    }
  }
}

export function coordinateQualityCompletion(
  root: string,
  signal: AbortSignal | undefined,
  execute: () => Promise<QualityCompletionResult>,
): Promise<QualityCompletionResult> {
  const canonicalRoot = fs.realpathSync(root);
  const existing = localRuns.get(canonicalRoot);
  if (existing) return existing;
  const running = coordinatedRun(canonicalRoot, signal, execute).finally(() => {
    if (localRuns.get(canonicalRoot) === running) localRuns.delete(canonicalRoot);
  });
  localRuns.set(canonicalRoot, running);
  return running;
}
