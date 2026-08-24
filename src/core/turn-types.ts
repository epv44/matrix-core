export type TurnStatus =
  "RUNNING" | "VALIDATING" | "VALIDATED_COMPLETE" | "REJECT" | "ERROR" | "CANCELLED" | "VALIDATION_FAILED";

export interface RepoHash {
  hash: string;
  computedAt: string;
  head: string;
  dirtyFiles: string[];
}

export interface ValidationCheck {
  name: string;
  status: "PASS" | "FAIL" | "ERROR" | "SKIPPED";
  findings: string[];
}

export interface ValidationEvidence {
  schemaVersion: number;
  repositoryHash: string;
  policyHash: string;
  result: "PASS" | "REJECT" | "ERROR";
  checks: ValidationCheck[];
  timestamp: string;
  reviewId?: string;
  gateVersion: string;
  gateMode: "full" | "changed" | "fast";
  gateFast?: boolean;
}

export interface TurnGateState {
  schemaVersion: number;
  dirty: boolean;
  currentHash: string | null;
  validatedHash: string | null;
  status: TurnStatus;
  attempts: number;
  lastValidationEvidence: ValidationEvidence | null;
  retryCountByHash: Record<string, number>;
  activeTurnId: string | null;
  updatedAt: string;
}

export interface TurnEvent {
  type:
    | "DIRTY"
    | "CANDIDATE_COMPLETE"
    | "VALIDATION_COMPLETE"
    | "VALIDATED_COMPLETE"
    | "GATE_FAILED"
    | "CANCELLED"
    | "RESET";
  host: "cline" | "codex" | "claude" | "cli" | "mcp";
  turnId?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface TurnGateResult {
  decision: "allow" | "block" | "error";
  reason: string;
  currentHash: string;
  validatedHash: string | null;
  evidence?: ValidationEvidence;
  retryCount: number;
}
