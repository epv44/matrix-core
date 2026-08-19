import type { FixRequest, FixTask, GateResult, QualityReviewResult, ReviewResult } from "../core/types.js";
import type { RunGateOptions } from "../core/gate.js";
import type { ReviewProvider } from "../agentsmith/provider.js";

export interface CoreServices {
  runGate(opts: RunGateOptions): Promise<GateResult>;
  currentVersion(cwd: string): string;
  readGateResult(cwd: string): GateResult | null;
  runReview(opts: { cwd: string; version: string; base?: string; signal?: AbortSignal }): Promise<ReviewResult>;
  runQualityReview(
    opts: RunGateOptions & { signal?: AbortSignal; provider?: ReviewProvider },
  ): Promise<QualityReviewResult>;
  prepareFix(opts: FixRequest): FixTask;
}
