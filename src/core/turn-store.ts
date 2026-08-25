import fs from "node:fs";
import path from "node:path";
import { computeWorkspaceVersion } from "./version.js";
import { resolveConfig } from "./config-resolver.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { atomicWriteFile } from "./filesystem.js";
import type { GateResult } from "./types.js";
import type { TurnGateState, ValidationEvidence, TurnEvent } from "./turn-types.js";

const STORE_DIR = ".quality";
const STATE_FILE = "turn-state.json";
const EVENTS_FILE = "turn-events.jsonl";

function storePath(root: string): string {
  return path.join(root, STORE_DIR, STATE_FILE);
}

function eventsPath(root: string): string {
  return path.join(root, STORE_DIR, EVENTS_FILE);
}

function currentPolicyHash(root: string): string | null {
  try {
    return resolvePolicyForConfig(resolveConfig({ cwd: root })).policyHash;
  } catch {
    return null;
  }
}

function withStoreLock<T>(root: string, action: () => T): T {
  const lockPath = path.join(root, STORE_DIR, "turn-state.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd: number | undefined;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const wait = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(wait, 0, 0, 10);
    }
  }
  if (fd === undefined) throw new Error("Timed out acquiring MatrixCore turn-state lock");
  try {
    return action();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {}
  }
}

function defaultState(): TurnGateState {
  return {
    schemaVersion: 1,
    dirty: false,
    currentHash: null,
    validatedHash: null,
    status: "RUNNING",
    attempts: 0,
    lastValidationEvidence: null,
    retryCountByHash: {},
    activeTurnId: null,
    updatedAt: new Date().toISOString(),
  };
}

function readState(root: string): TurnGateState {
  const p = storePath(root);
  try {
    const raw = fs.readFileSync(p, "utf8");
    const parsed = JSON.parse(raw) as TurnGateState;
    if (parsed.schemaVersion === 1) return parsed;
  } catch {}
  return defaultState();
}

function writeState(root: string, state: TurnGateState): void {
  state.updatedAt = new Date().toISOString();
  atomicWriteFile(storePath(root), JSON.stringify(state, null, 2));
}

function appendEvent(root: string, event: TurnEvent): void {
  const p = eventsPath(root);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, `${JSON.stringify(event)}\n`);
  } catch {}
}

export const turnStore = {
  getState(root: string): TurnGateState {
    return readState(root);
  },

  setDirty(
    root: string,
    currentHash: string,
    host: "cline" | "codex" | "claude" | "cli" | "mcp" = "cline",
    turnId?: string,
  ): void {
    withStoreLock(root, () => {
      const state = readState(root);
      state.dirty = true;
      state.currentHash = currentHash;
      state.status = "RUNNING";
      if (turnId) state.activeTurnId = turnId;
      writeState(root, state);
      appendEvent(root, {
        type: "DIRTY",
        host,
        turnId,
        payload: { hash: currentHash },
        timestamp: new Date().toISOString(),
      });
    });
  },

  candidateComplete(
    root: string,
    host: "cline" | "codex" | "claude",
    currentHash: string,
    turnId?: string,
  ): TurnGateState {
    return withStoreLock(root, () => {
      const state = readState(root);
      if (turnId && state.activeTurnId !== turnId) {
        state.retryCountByHash = {};
        state.activeTurnId = turnId;
      }
      state.currentHash = currentHash;
      state.attempts += 1;
      state.status = "VALIDATING";
      const count = state.retryCountByHash[currentHash] || 0;
      state.retryCountByHash[currentHash] = count + 1;
      writeState(root, state);
      appendEvent(root, {
        type: "CANDIDATE_COMPLETE",
        host,
        turnId,
        payload: { hash: currentHash },
        timestamp: new Date().toISOString(),
      });
      return state;
    });
  },

  validationComplete(
    root: string,
    evidence: ValidationEvidence,
    host: "cline" | "codex" | "claude" | "cli" | "mcp" = "cline",
    turnId?: string,
  ): TurnGateState {
    return withStoreLock(root, () => {
      const state = readState(root);
      const liveHash = computeWorkspaceVersion(root);
      const policyMatches = currentPolicyHash(root) === evidence.policyHash;
      state.currentHash = liveHash;
      const completionEligible = evidence.gateMode === "full" && evidence.gateFast !== true;
      state.dirty =
        evidence.result !== "PASS" || !completionEligible || liveHash !== evidence.repositoryHash || !policyMatches;
      if (evidence.result === "PASS" && completionEligible && liveHash === evidence.repositoryHash && policyMatches) {
        state.validatedHash = evidence.repositoryHash;
        state.status = "VALIDATED_COMPLETE";
      } else {
        state.status = evidence.result === "REJECT" ? "REJECT" : "ERROR";
      }
      state.lastValidationEvidence = evidence;
      if (turnId) state.activeTurnId = turnId;
      if (
        evidence.result === "PASS" &&
        completionEligible &&
        liveHash === evidence.repositoryHash &&
        policyMatches &&
        state.retryCountByHash[evidence.repositoryHash]
      ) {
        delete state.retryCountByHash[evidence.repositoryHash];
      }
      writeState(root, state);
      appendEvent(root, {
        type:
          liveHash === evidence.repositoryHash && evidence.result === "PASS" && completionEligible && policyMatches
            ? "VALIDATED_COMPLETE"
            : "VALIDATION_COMPLETE",
        host,
        turnId,
        payload: { result: evidence.result, hash: evidence.repositoryHash, liveHash, policyMatches },
        timestamp: new Date().toISOString(),
      });
      return state;
    });
  },

  validationFailed(
    root: string,
    currentHash: string,
    host: "cline" | "codex" | "claude" = "cline",
    turnId?: string,
  ): TurnGateState {
    return withStoreLock(root, () => {
      const state = readState(root);
      state.status = "VALIDATION_FAILED";
      state.dirty = true;
      state.currentHash = currentHash;
      writeState(root, state);
      appendEvent(root, {
        type: "GATE_FAILED",
        host,
        turnId,
        payload: { result: "ERROR", hash: currentHash },
        timestamp: new Date().toISOString(),
      });
      return state;
    });
  },

  cancelled(root: string): TurnGateState {
    return withStoreLock(root, () => {
      const state = readState(root);
      state.status = "CANCELLED";
      writeState(root, state);
      appendEvent(root, {
        type: "CANCELLED",
        host: "cline",
        payload: { result: "CANCELLED" },
        timestamp: new Date().toISOString(),
      });
      return state;
    });
  },

  failed(root: string, error: string, host: "cline" | "codex" | "claude" = "cline", turnId?: string): TurnGateState {
    return withStoreLock(root, () => {
      const state = readState(root);
      state.status = "ERROR";
      state.dirty = true;
      state.currentHash = state.currentHash || computeWorkspaceVersion(root);
      writeState(root, state);
      appendEvent(root, {
        type: "GATE_FAILED",
        host,
        turnId,
        payload: { result: "ERROR", error },
        timestamp: new Date().toISOString(),
      });
      return state;
    });
  },

  recordGateResult(
    root: string,
    gate: GateResult,
    result: ValidationEvidence["result"],
    host: "cline" | "codex" | "claude" | "cli" | "mcp" = "cline",
    turnId?: string,
  ): TurnGateState {
    const evidence: ValidationEvidence = {
      schemaVersion: 1,
      repositoryHash: gate.version,
      policyHash: gate.policy.policyHash,
      result,
      checks: gate.checks.map((check) => ({
        name: check.plugin,
        status:
          check.status === "FAIL"
            ? "FAIL"
            : check.status === "ERROR"
              ? "ERROR"
              : check.status === "SKIPPED"
                ? "SKIPPED"
                : "PASS",
        findings: check.observations?.map((observation) => observation.message) ?? [],
      })),
      timestamp: new Date().toISOString(),
      gateVersion: gate.version,
      gateMode: gate.mode,
      gateFast: gate.fast,
    };
    return turnStore.validationComplete(root, evidence, host, turnId);
  },

  reset(root: string): TurnGateState {
    return withStoreLock(root, () => {
      const state = defaultState();
      writeState(root, state);
      appendEvent(root, { type: "RESET", host: "cline", payload: {}, timestamp: new Date().toISOString() });
      return state;
    });
  },

  getRetryCount(root: string, hash: string): number {
    const state = readState(root);
    return state.retryCountByHash[hash] || 0;
  },

  listEvents(root: string, limit = 50): TurnEvent[] {
    const p = eventsPath(root);
    try {
      const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l) as TurnEvent);
    } catch {
      return [];
    }
  },
};
