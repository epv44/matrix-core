import { computeWorkspaceVersion } from "./version.js";
import { turnStore } from "./turn-store.js";
import { runGate, type RunGateOptions } from "./gate.js";
import { getQualityStatus } from "./status.js";
import { resolveConfig } from "./config-resolver.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import type { TurnGateResult, ValidationEvidence, TurnGateState } from "./turn-types.js";
import type { GateResult } from "./types.js";

const MAX_RETRIES = 3;

function toValidationEvidence(gate: GateResult, policyHash: string): ValidationEvidence {
  const checks = gate.checks.map((c) => ({
    name: c.plugin,
    status: c.status as "PASS" | "FAIL" | "ERROR" | "SKIPPED",
    findings: c.observations?.map((o) => o.message) ?? [],
  }));
  return {
    schemaVersion: 1,
    repositoryHash: gate.version,
    policyHash,
    result: gate.status === "PASS" ? "PASS" : gate.status === "FAIL" ? "REJECT" : "ERROR",
    checks,
    timestamp: new Date().toISOString(),
    gateVersion: gate.version,
    gateMode: gate.mode,
    gateFast: gate.fast,
  };
}

function getPolicyHash(root: string): string {
  const resolved = resolveConfig({ cwd: root });
  const policy = resolvePolicyForConfig(resolved);
  return policy.policyHash;
}

export class TurnGate {
  private root: string;

  constructor(root: string) {
    this.root = root;
  }

  async onCandidateComplete(host: "cline" | "codex" | "claude", turnId?: string): Promise<TurnGateResult> {
    const currentHash = computeWorkspaceVersion(this.root);
    const policyHash = getPolicyHash(this.root);
    const maxRetries = resolveConfig({ cwd: this.root }).config.gates?.max_retries ?? MAX_RETRIES;
    const initialStatus = getQualityStatus(this.root);
    if (!initialStatus.configured) {
      return {
        decision: "allow",
        reason: "MatrixCore is not configured for this workspace",
        currentHash,
        validatedHash: null,
        retryCount: 0,
      };
    }

    // First, check if there's a matching PASS gate
    let gate = turnStore.getState(this.root).lastValidationEvidence ? await this.readGateForHash(currentHash) : null;

    if (!gate) {
      const { readGateResult } = await import("./gate-store.js");
      const fullGate = readGateResult(this.root, "full");
      if (fullGate && fullGate.version === currentHash && fullGate.status === "PASS") {
        gate = fullGate;
      }
    }

    if (gate && gate.version === currentHash && gate.status === "PASS") {
      // Use getQualityStatus which already composes version + live workspaceHash + policyHash + toolVersions
      const status = getQualityStatus(this.root);

      if (!status.completionAllowed) {
        const state = turnStore.candidateComplete(this.root, host, currentHash, turnId);
        const retryCount = state.retryCountByHash[currentHash] || 0;
        if (retryCount > maxRetries) {
          turnStore.validationFailed(this.root, currentHash, host, turnId);
          return {
            decision: "error",
            reason: `Validation failed after ${maxRetries} attempts. Repository hash: ${currentHash.slice(0, 12)}. Manual intervention required.`,
            currentHash,
            validatedHash: state.validatedHash,
            retryCount,
          };
        }
        return {
          decision: "block",
          reason: `${status.reason ?? "Completion evidence is not current. Re-run validation."} (policy=${policyHash})`,
          currentHash,
          validatedHash: state.validatedHash,
          retryCount,
        };
      }

      const finalHash = computeWorkspaceVersion(this.root);
      const finalStatus = getQualityStatus(this.root);
      if (finalHash !== currentHash || !finalStatus.completionAllowed) {
        const state = turnStore.candidateComplete(this.root, host, finalHash, turnId);
        return {
          decision: "block",
          reason:
            finalHash !== currentHash
              ? "Repository changed while completion was being checked. Run final validation again."
              : (finalStatus.reason ?? "Completion evidence is no longer current."),
          currentHash: finalHash,
          validatedHash: state.validatedHash,
          retryCount: state.retryCountByHash[finalHash] || 0,
        };
      }

      // Matching PASS gate found - persist and allow only after the store verifies the live hash
      const state = turnStore.getState(this.root);
      if (state.retryCountByHash[currentHash]) {
        delete state.retryCountByHash[currentHash];
      }
      const evidence = toValidationEvidence(gate, policyHash);
      const completed = turnStore.validationComplete(this.root, evidence, host, turnId);
      if (completed.status !== "VALIDATED_COMPLETE") {
        return {
          decision: "block",
          reason: "Repository changed while completion evidence was being persisted. Run final validation again.",
          currentHash,
          validatedHash: completed.validatedHash,
          retryCount: completed.retryCountByHash[currentHash] || 0,
        };
      }
      return {
        decision: "allow",
        reason: `Validation PASS for current repository state`,
        currentHash,
        validatedHash: currentHash,
        evidence,
        retryCount: 0,
      };
    }

    // No matching PASS gate - check retry count
    const status = initialStatus;
    const state = turnStore.candidateComplete(this.root, host, currentHash, turnId);
    const retryCount = state.retryCountByHash[currentHash] || 0;

    if (retryCount > maxRetries) {
      turnStore.validationFailed(this.root, currentHash, host, turnId);
      return {
        decision: "error",
        reason: `Validation failed after ${maxRetries} attempts. Repository hash: ${currentHash.slice(0, 12)}. Manual intervention required.`,
        currentHash,
        validatedHash: state.validatedHash,
        retryCount,
      };
    }

    const findings = this.extractFindings(status);

    return {
      decision: "block",
      reason: `Final validation required for current repository state (${currentHash.slice(0, 12)}). Run the configured validation pipeline and resolve all failures. ${findings} (policy=${policyHash})`,
      currentHash,
      validatedHash: state.validatedHash,
      retryCount,
    };
  }

  private async readGateForHash(hash: string): Promise<GateResult | null> {
    const { readGateResult } = await import("./gate-store.js");
    const gate = readGateResult(this.root, "full");
    if (gate && gate.version === hash) return gate;
    return null;
  }

  private extractFindings(status: ReturnType<typeof getQualityStatus>): string {
    const parts: string[] = [];
    if (status.gate?.checks) {
      const failures = status.gate.checks.filter((c) => c.status === "FAIL");
      if (failures.length) {
        parts.push(`Failures: ${failures.map((f) => `${f.plugin}: ${f.reason || f.status}`).join(", ")}`);
      }
    }
    if (status.review?.findings?.length) {
      parts.push(`Review: ${status.review.findings.length} findings`);
    }
    return parts.join("; ");
  }

  async onValidationComplete(mode: "full" | "changed" = "full"): Promise<TurnGateResult> {
    const currentHash = computeWorkspaceVersion(this.root);

    const opts: RunGateOptions = {
      cwd: this.root,
      mode,
      tool: "quality_run",
      adapter: "cli",
    };
    const gate = await runGate(opts);
    const policyHash = getPolicyHash(this.root);
    const evidence = toValidationEvidence(gate, policyHash);

    if (gate.status === "PASS") {
      const completed = turnStore.validationComplete(this.root, evidence);
      return {
        decision: completed.status === "VALIDATED_COMPLETE" ? "allow" : "block",
        reason:
          completed.status === "VALIDATED_COMPLETE"
            ? "Validation completed successfully"
            : "Validation evidence is stale; rerun the gate",
        currentHash,
        validatedHash: gate.version,
        evidence,
        retryCount: 0,
      };
    }

    // Distinguish infra ERROR from code REJECT
    // GateResult.status is "PASS" | "FAIL" | "RUNNING" | "EXPIRED" - no "ERROR"
    // Infra errors manifest as FAIL with specific failure messages
    const isInfraError =
      gate.status === "FAIL" &&
      gate.failures.some(
        (f) =>
          f.includes("required workspace tool missing") ||
          f.includes("executable not found but required=true") ||
          f.includes("executable not found in designated environment") ||
          f.includes("deptry and Python must exist in the designated virtual environment") ||
          f.includes("tsc not found but required=true") ||
          f.includes("eslint not found") ||
          f.includes("prettier not found") ||
          f.includes("SQLFluff and its Python environment are missing from the designated SQL facet") ||
          f.includes("golangci-lint not found") ||
          f.includes("go not found") ||
          f.includes("go missing") ||
          f.includes("not found but required=true") ||
          f.includes("Clippy not found") ||
          f.includes("not found but required=true") ||
          f.includes("executable not found but required=true"),
      );
    const decision = isInfraError ? "error" : "block";
    evidence.result = isInfraError ? "ERROR" : "REJECT";
    turnStore.validationComplete(this.root, evidence);
    return {
      decision,
      reason:
        gate.status === "FAIL"
          ? `Validation FAIL: ${gate.failures.join(", ")}`
          : `Validation ${gate.status}: ${gate.failures.join(", ")}`,
      currentHash,
      validatedHash: gate.version,
      evidence,
      retryCount: 0,
    };
  }

  onDirty(host: "cline" | "codex" | "claude" = "cline", turnId?: string): void {
    const currentHash = computeWorkspaceVersion(this.root);
    turnStore.setDirty(this.root, currentHash, host, turnId);
  }

  getStatus(): TurnGateState {
    return turnStore.getState(this.root);
  }
}
