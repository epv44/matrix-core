import type {
  CandidateResolutionAudit,
  CandidateFinding,
  EvidenceRecord,
  EvidenceResolutionOutcome,
  ModelProfile,
  ReviewCategory,
  ReviewCoverage,
  ReviewMode,
  ReviewPath,
  ReviewSeverity,
  SpecialistReviewerId,
} from "../core/types.js";
import type { GraphContextEdge, GraphSnapshot, GraphSymbol } from "../core/graph/types.js";
import type { ProviderCompletionMetadata, ProviderUsage, ReviewOutputKind } from "./provider.js";

export type OmissionReason =
  | "binary"
  | "generated"
  | "unsupported-artifact"
  | "unsafe-large-file"
  | "token-budget"
  | "lower-ranked"
  | "timeout"
  | "provider-failure";

export interface ReviewOmission {
  kind: "file" | "symbol" | "edge" | "context" | "work-item" | "candidate";
  id: string;
  reason: OmissionReason;
  details?: string;
}

export interface FileEntry {
  path: string;
  changeKind: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  language?: string;
  generated: boolean;
  binary: boolean;
  sizeBytes?: number;
  oldPath?: string;
}

export interface ProjectionBudget {
  contextTokens: number;
  inputBudgetTokens: number;
  requestedOutputTokens: number;
  safetyReserveTokens: number;
}

export interface ProjectedSnippet {
  id: string;
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  content: string;
  changed: boolean;
  changedLineRanges?: Array<{ start: number; end: number }>;
  score: number;
  reason: string;
  estimatedTokens: number;
}

export interface ProjectionAuditItem {
  kind: "instructions" | "rules" | "manifest" | "code" | "graph" | "report" | "dependency-summary" | "context-summary";
  id: string;
  estimatedTokens: number;
  score: number;
  status: "selected" | "truncated" | "omitted";
  reason?: string;
}

export interface ReviewProjection {
  id: string;
  kind: "full" | "compact" | "work-item";
  estimatedTokens: number;
  manifest: FileEntry[];
  rules: RenderedRule[];
  code: ProjectedSnippet[];
  graphEdges: GraphContextEdge[];
  graphSummary: string;
  deterministicReport?: string;
  dependencySummary: string[];
  contextSummary: string[];
  metadata: { base: string | null; snapshotId: string; languages: string[] };
  audit: ProjectionAuditItem[];
  omissions: ReviewOmission[];
}

export interface ReviewWorkItem {
  id: string;
  kind: "local" | "interaction";
  /** One-based position assigned by Ranking and preserved into Selection. */
  rank?: number;
  priority?: number;
  primarySymbols: GraphSymbol[];
  relatedSymbols: GraphSymbol[];
  code: ProjectedSnippet[];
  /** Canonical changed regions owned by this unit before prompt packing. */
  changedRegions?: Array<{ file: string; start: number; end: number }>;
  /** Exact source ranges visible to the candidate model after packing. */
  promptVisibleRanges?: Array<{ file: string; start: number; end: number }>;
  graphEdges: GraphContextEdge[];
  rules: RenderedRule[];
  deterministicReport?: string;
  contextSummaries?: string[];
  estimatedTokens: number;
  rankFactors?: {
    semanticRisk?: number;
    edgeRisk: number;
    changedEndpoints: number;
    productionSurface: number;
    changedLines: number;
    graphDegree: number;
    fanIn?: number;
    fanOut?: number;
    neighborDegree?: number;
    directedIncidentDegree?: number;
    degreeContribution?: number;
  };
  selectionReason?: string;
}

export interface RuleTrigger {
  languages?: string[];
  categories?: ReviewCategory[];
  paths?: string[];
  symbolKinds?: string[];
  edgeKinds?: string[];
  keywords?: string[];
}

export interface StructuredReviewRule {
  id: string;
  languages: string[];
  categories: ReviewCategory[];
  severity?: ReviewSeverity;
  triggers: RuleTrigger[];
  short: string;
  explanation: string;
  examples?: Array<{ bad: string; good?: string }>;
}

export interface RenderedRule {
  id: string;
  text: string;
  estimatedTokens: number;
}

export interface ScoutFinding {
  hotspotId: string;
  risk: "critical" | "high" | "medium" | "low";
  category: ReviewCategory;
  symbols: string[];
  edges: string[];
  rationale: string;
  requestedInspection: { symbols: string[]; edgeKinds?: string[] };
}

export interface CandidateBatch {
  sourceId: string;
  specialist?: SpecialistReviewerId;
  summary?: string;
  candidates: CandidateFinding[];
  inputTokens: number;
  outputTokens: number;
  prompt?: string;
  raw?: string;
  completion?: ProviderCompletionMetadata;
  cacheStatus?: "hit" | "miss";
  diagnostics?: ProviderFailureDiagnostic[];
  contractDrops?: Array<{
    candidateIndex: number;
    reason: "unknown-selector" | "invalid-selector";
    selector?: string;
  }>;
  error?: string;
}

export interface VerificationResult {
  candidateId: string;
  verdict: "verified" | "likely" | "rejected" | "insufficient_evidence";
  confidence: number;
  reasoningSummary?: string;
  supportingEvidenceIds: string[];
  /** Raw attempt-1 verifier emission before any citation repair, for grounding diagnostics. */
  rawVerdict?: VerificationResult["verdict"];
  rawConfidence?: number;
  rawSupportingEvidenceIds?: string[];
  prompt?: string;
  raw?: string;
  completion?: ProviderCompletionMetadata;
  cacheStatus?: "hit" | "miss";
  diagnostics?: ProviderFailureDiagnostic[];
  citationRepairAttempted?: boolean;
  providerInvocations?: number;
}

export interface ProviderFailureDiagnostic {
  sourceId: string;
  outputKind: ReviewOutputKind;
  prompt: string;
  raw: string;
  usage: ProviderUsage;
  completion: ProviderCompletionMetadata;
  parseError: string;
  failureKind: "json-syntax" | "schema-validation" | "citation-validation";
  validationIssues: Array<{ path: string; message: string }>;
  attempt: number;
  parsePosition: number | null;
  parseContext: string;
}

export interface RouteDecision {
  mode: ReviewMode;
  reason: string;
  fullProjectionTokens: number;
  compactProjectionTokens: number;
  candidateBudget: ProjectionBudget;
  scoutBudget?: ProjectionBudget;
}

export interface EngineExecution {
  /** Phase 1 contract audit. Shadow-only: never consumed by execution decisions. */
  contractShadow?: ContractShadowAudit;
  rankingConfig?: {
    maxDegreeBoost: number;
    degreeCap: number;
  };
  graphSnapshot: GraphSnapshot;
  graphManifest?: {
    changedSymbols: GraphSymbol[];
    nodes: GraphSymbol[];
    edges: GraphContextEdge[];
    selectedNodeKeys: string[];
    omittedNodeKeys: string[];
  };
  mode: ReviewMode;
  reviewPath: ReviewPath;
  route: RouteDecision;
  modelProfiles: { candidate: ModelProfile; scout?: ModelProfile; verifier: ModelProfile };
  projection: ReviewProjection;
  /** Repository-wide projection used to plan/rank review work. */
  sourceProjection?: ReviewProjection;
  /** Union of the exact snippets visible to selected candidate calls. */
  candidateProjection?: ReviewProjection;
  compactProjection?: ReviewProjection;
  scout?: {
    prompt: string;
    raw: string;
    hotspots: ScoutFinding[];
    inputTokens: number;
    outputTokens: number;
    completion?: ProviderCompletionMetadata;
    diagnostics?: ProviderFailureDiagnostic[];
    cacheStatus?: "hit" | "miss";
  };
  workItems: ReviewWorkItem[];
  candidateBatches: CandidateBatch[];
  candidates: CandidateFinding[];
  evidence: Record<string, EvidenceRecord[]>;
  evidenceOutcomes?: Record<string, EvidenceResolutionOutcome[]>;
  verification: VerificationResult[];
  candidateResolutions: CandidateResolutionAudit[];
  providerFailures?: ProviderFailureDiagnostic[];
  providerDiagnostics?: ProviderFailureDiagnostic[];
  coverage: ReviewCoverage;
  errors: string[];
  inputTokens: number;
  outputTokens: number;
  stageTimingsMs?: Partial<
    Record<
      | "snapshot"
      | "providerHealth"
      | "graph"
      | "projection"
      | "planning"
      | "ranking"
      | "selection"
      | "candidateGeneration"
      | "evidence"
      | "verification"
      | "aggregation"
      | "reporting",
      number
    >
  >;
  plannerManifest?: Array<{
    id: string;
    kind: ReviewWorkItem["kind"];
    rank?: number;
    priority: number;
    estimatedTokens: number;
    selected: boolean;
    tokenOmitted: boolean;
    files: string[];
    symbols: string[];
    edges: string[];
    changedRegions?: ReviewWorkItem["changedRegions"];
    promptVisibleRanges?: ReviewWorkItem["promptVisibleRanges"];
    rankFactors?: ReviewWorkItem["rankFactors"];
    selectionReason?: string;
  }>;
}

export interface ContractShadowAuditEntry {
  sourceWorkItemId: string;
  taskId: string;
  descriptorHash: string;
  serializedDescriptor: string;
  validation: { valid: true } | { valid: false; error: string };
  legacyInputFingerprint: string;
  legacyOutputFingerprint?: string;
}

export interface ContractShadowAudit {
  schemaVersion: 1;
  lens: "correctness";
  entries: ContractShadowAuditEntry[];
}
