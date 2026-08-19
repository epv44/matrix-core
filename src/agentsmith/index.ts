import { AGENT_SMITH, reviewerRegistry } from "../core/reviewer.js";
import type { Reviewer } from "../core/reviewer.js";
import type { ReviewResult } from "../core/types.js";
import { runReview } from "./scripts/run-review.js";

export const smithReviewer: Reviewer = {
  name: AGENT_SMITH,
  async review(input: { version: string; cwd: string }): Promise<ReviewResult> {
    return runReview({ cwd: input.cwd, version: input.version });
  },
};

reviewerRegistry.set(smithReviewer);

export { runReview };
export { hashDiff } from "./scripts/hash-diff.js";
export { executeReviewEngine } from "./engine.js";
export { buildProjection, buildWorkItems, projectionBudget, routeReview } from "./projection.js";
export { loadStructuredRules, selectRules } from "./rules.js";
export { candidateAnchorIssue, resolveEvidenceRequests } from "./evidence.js";
export { isAgentSmithTraceEnabled, listAgentSmithTraces, readAgentSmithTrace, traceStatus } from "./trace.js";
export { curateTrace, listEvalCases, readEvalCase, runEvalCases, scoreFindings } from "./eval.js";
export { formatAgentSmithReview, REVIEW_MARKDOWN_ARTIFACT } from "./report.js";
export {
  loadAgent,
  loadAgents,
  loadOrchestrator,
  loadRule,
  loadRules,
  loadSecurityAgents,
  loadSkill,
  loadSkills,
  loadSubAgents,
} from "./registry.js";
export { AGENT_SMITH } from "../core/reviewer.js";
export type { AgentDef, AgentKind, RuleDef, SkillDef } from "./types.js";
export type { HashDiffOptions } from "./scripts/hash-diff.js";
export type { RunReviewDeps, RunReviewOptions } from "./scripts/run-review.js";
export type * from "./engine-types.js";
