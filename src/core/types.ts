export type PluginStatus = "PASS" | "FAIL" | "SKIPPED" | "ERROR";
export interface Observation {
  file?: string;
  line?: number;
  col?: number;
  message: string;
  severity: "error" | "warn" | "info";
  ruleId?: string;
}
export interface PluginResult {
  plugin: string;
  status: PluginStatus;
  score?: number | null;
  observations: Observation[];
  metrics?: Record<string, number | null>;
  reason?: string;
  pack?: string;
}
export interface Capability {
  name: string;
  found: boolean;
  version?: string;
  path?: string;
  required: boolean;
  hint?: string;
}
export interface CheckCfg {
  enabled: boolean;
  required: boolean;
  fast?: boolean;
  args?: string[];
  cwd?: string;
}
export interface FastStageCfg {
  checks?: string[];
}
export interface StagesCfg {
  fast?: FastStageCfg;
}
export interface PolicyCfg {
  metric: string;
  degradation_allowed?: number;
  max_increase_percent?: number;
  max?: number;
  absolute_min?: number;
}
export interface GateCfg {
  after_tool?: "prompt" | "strict";
  after_run?: "prompt" | "strict";
  max_retries?: number;
  hook_timeout_ms?: number;
}
export interface QualityConfig {
  version: 2;
  project?: string;
  review?: {
    agentsmith: boolean;
    mode?: ReviewMode | "auto";
    models?: { candidate?: string; scout?: string; verifier?: string };
    parallelism?: number;
    maxDurationMs?: number;
  };
  policySource?: GitHubPolicySource;
  application?: ApplicationConfig;
  checks: Record<string, CheckCfg>;
  policies: Record<string, PolicyCfg>;
  plugins?: string[];
  packs?: Record<string, { enabled?: boolean; required?: boolean }>;
  stages?: StagesCfg;
  gates?: GateCfg;
  agentsmith?: AgentSmithConfig;
}

export interface GitHubPolicySource {
  source: "github";
  repository: string;
  ref: string;
  manifest: string;
}

export type SqlSourceKind = "files" | "python";
export interface SqlApplicationFacet {
  root: string;
  dialect: string;
  templater: "raw" | "jinja" | "python" | "placeholder";
  sources: SqlSourceKind[];
}
export interface ApplicationConfig {
  sql?: SqlApplicationFacet[];
}

export type WorkspaceLanguage = "python" | "typescript" | "go" | "rust";
export interface ToolEnvironment {
  kind: "python-venv" | "node-package" | "go-module" | "cargo-package" | "system";
  root: string;
  binaries: Record<string, string>;
}
export interface ResolutionEvidence {
  kind: "source" | "manifest" | "lockfile" | "config" | "environment";
  path: string;
  detail: string;
}
export interface LanguageWorkspace {
  id: string;
  language: WorkspaceLanguage;
  sourceRoot: string;
  packageRoot: string;
  executionRoot: string;
  applicationConfigs: string[];
  dependencyFiles: string[];
  toolEnvironment: ToolEnvironment;
  sqlFacets: SqlWorkspaceFacet[];
  resolutionEvidence: ResolutionEvidence[];
  resolutionHash: string;
  effectiveConfigHash?: string;
}
export interface SqlWorkspaceFacet {
  id: string;
  ownerWorkspaceId: string;
  sourceRoot: string;
  dialect: string;
  templater: "raw" | "jinja" | "python" | "placeholder";
  sources: SqlSourceKind[];
  toolEnvironment: ToolEnvironment;
  resolutionEvidence: ResolutionEvidence[];
  resolutionHash: string;
}
export interface WorkspaceResolution {
  schemaVersion: 1;
  workspaces: LanguageWorkspace[];
  workspaceHash: string;
}
export interface PolicyCheck {
  id: string;
  language: WorkspaceLanguage | "sql";
  tool: string;
  requiredVersion: string;
  configAsset?: string;
  configHash?: string;
  args: string[];
  settings?: Record<string, unknown>;
}

export type ReviewMode = "holistic" | "partitioned" | "hybrid";
export type ReviewCapability = "small" | "strong";
export type ReviewPath = "generic" | "specialist";
export type ReviewCategory = "correctness" | "security" | "performance" | "contract";
export type ReviewSeverity = "critical" | "high" | "medium" | "low";
export type SpecialistReviewerId = "architecture-reviewer" | "perf-reviewer" | "bug-hunter" | "semantic-reviewer";

export interface TokenEstimatorProfile {
  kind: "conservative-ratio";
  /** Separate ratios keep source-heavy projections conservatively bounded. */
  codeCharsPerToken: number;
  proseCharsPerToken: number;
}

export interface ModelProfile {
  id: string;
  provider: "ollama";
  model: string;
  contextTokens: number;
  reviewCapability: ReviewCapability;
  requestedOutputTokens: number;
  safetyReserveTokens: number;
  tokenizer: TokenEstimatorProfile;
  inference: { temperature: number; thinking: boolean; timeoutMs: number };
}

export interface ModelRoleBindings {
  candidate: string;
  scout?: string;
  verifier?: string;
}

export interface ReviewRoutingPolicy {
  inputContextFraction: number;
  enableHolistic: boolean;
  enablePartitioned: boolean;
  enableHybrid: boolean;
}

export interface ReviewGraphPolicy {
  defaultHops: 1;
  maxHops: 1 | 2;
  maxInteractionNeighborsPerSymbol: number;
  enableHighRiskTwoHopExpansion: boolean;
}

export interface PartitionedReviewPolicy {
  maxParallelUnits: number;
  maxRulesPerUnit: number;
  maxUnitsPerChangedSymbol: number;
  /** Maximum candidate-generation work items selected for one review. */
  maxCandidateWorkItems?: number;
  /** Maximum model candidates sent through verification. */
  maxVerificationCandidates?: number;
  /** Maximum candidates accepted from one partitioned model call. */
  maxCandidatesPerWorkItem?: number;
  /** Total estimated candidate-generation input budget override. */
  maxCandidateInputTokens?: number;
  /** Total estimated verification input budget override. */
  maxVerificationInputTokens?: number;
  preferSemanticBoundaries: boolean;
  hunkFallback: boolean;
}

export interface HolisticReviewPolicy {
  maxCandidates: number;
}

export interface HybridReviewPolicy {
  maxHotspots: number;
  redundantDeepMode: boolean;
}

export interface EvidencePolicy {
  maxRequestsPerCandidate: number;
  maxParallelResolutions: number;
  maxSnippetLines: number;
  maxRecordsPerRequest?: number;
  maxRecordsPerCandidate?: number;
}

export interface VerificationPolicy {
  enabled: boolean;
  publish: "verified-only";
}

export interface AgentSmithProfile {
  id: string;
  hash: string;
  outputSchemaVersion: number;
  provider: string;
  /** Locked model definitions. Projects bind roles to these IDs. */
  models: ModelProfile[];
  defaultModels: ModelRoleBindings;
  routing: ReviewRoutingPolicy;
  graph: ReviewGraphPolicy;
  partitioned: PartitionedReviewPolicy;
  holistic: HolisticReviewPolicy;
  hybrid: HybridReviewPolicy;
  evidence: EvidencePolicy;
  verification: VerificationPolicy;
  concurrency: number;
  maxDurationMs: number;
  cache: boolean;
  assetRoot?: string;
}
export interface PolicyProvenance {
  source: "embedded" | "github";
  repository?: string;
  configuredRef?: string;
  resolvedCommit?: string;
  manifest?: string;
  manifestHash?: string;
}
export interface ResolvedPolicy {
  schemaVersion: 1;
  provider: string;
  profileId: string;
  policyHash: string;
  checks: PolicyCheck[];
  agentSmith: AgentSmithProfile;
  provenance?: PolicyProvenance;
}
export interface AgentModelConfig {
  enabled?: boolean;
  model?: string;
}
export interface AgentSmithConfig {
  enabled: boolean;
  advisory: boolean;
  provider: string;
  base_url: string;
  mode: ReviewMode | "auto";
  model_profiles: ModelProfile[];
  models: ModelRoleBindings;
  routing: ReviewRoutingPolicy;
  graph: ReviewGraphPolicy;
  partitioned: PartitionedReviewPolicy;
  holistic: HolisticReviewPolicy;
  hybrid: HybridReviewPolicy;
  evidence: EvidencePolicy;
  verification: VerificationPolicy;
  concurrency: number;
  maxDurationMs: number;
  cache: boolean;
  context_files?: string[];
}
export interface ResolvedConfig {
  config: QualityConfig;
  configPath: string | null;
  configRoot: string;
  isDefault: boolean;
  workspaces?: LanguageWorkspace[];
  workspaceHash?: string;
  policy?: ResolvedPolicy;
}
export interface BaselineData {
  version: number;
  timestamp: string;
  configHash?: string;
  metrics: Record<string, number>;
}
export interface RunCtx {
  root: string;
  configRoot: string;
  changedFiles?: string[];
  full: boolean;
  baseBranch?: string;
  config?: QualityConfig;
  editedFile?: string;
  fast?: boolean;
  hasLanguage?: { python?: boolean; typescript?: boolean; go?: boolean; rust?: boolean };
  signal?: AbortSignal;
  workspace?: LanguageWorkspace;
  sqlFacet?: SqlWorkspaceFacet;
  policyCheck?: PolicyCheck;
}
export interface EngineResult {
  passed: boolean;
  results: PluginResult[];
  metrics: Record<string, number | null>;
  baseline: BaselineData | null;
  config: ResolvedConfig;
  capabilities: Capability[];
  failures: string[];
  report: string;
}

export type GateStatus = "PASS" | "FAIL" | "RUNNING" | "EXPIRED";

export interface GateOrigin {
  tool: string;
  adapter: string;
  engineVersion: string;
  enginePath?: string;
  enginePackageRoot?: string;
}

export interface EngineRuntimeIdentity {
  version: string;
  executablePath: string;
  packageRoot: string;
}

export interface CompletionIdentitySnapshot {
  workspaceVersion: string | null;
  workspaceHash: string | null;
  policyHash: string | null;
  toolVersions: Record<string, string>;
  engineVersion: string | null;
  enginePath: string | null;
  enginePackageRoot: string | null;
}

export interface CompletionIdentityDiagnostics {
  current: CompletionIdentitySnapshot;
  recorded: CompletionIdentitySnapshot | null;
  mismatches: string[];
}

export interface GateResult {
  schemaVersion: 2;
  version: string;
  mode: "changed" | "full";
  fast: boolean;
  baseBranch: string;
  changedFilesHash: string | null;
  changedFileCount: number;
  status: GateStatus;
  checks: PluginResult[];
  failures: string[];
  metrics: Record<string, number | null>;
  timestamp: string;
  createdBy: GateOrigin;
  workspaces: LanguageWorkspace[];
  workspaceHash: string;
  policy: ResolvedPolicy;
  toolVersions: Record<string, string>;
}

export type EvidenceRequestKind =
  "definition" | "callers" | "callees" | "type" | "implementation" | "usage" | "config" | "test" | "schema" | "search";

export interface EvidenceRequest {
  kind: EvidenceRequestKind;
  locatorMode?: "symbol" | "literal";
  symbol?: string;
  pathHint?: string;
  query?: string;
  reason: string;
}

export interface EvidenceRecord {
  id: string;
  requestKind: EvidenceRequestKind;
  file: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  snippet: string;
  relation?: string;
  requestId?: string;
  matchedLocator?: string;
  reason?: string;
}

export interface EvidenceResolutionOutcome {
  requestId: string;
  request: EvidenceRequest;
  status: "satisfied" | "partial" | "unresolved" | "skipped";
  records: EvidenceRecord[];
  packedRecordIds?: string[];
  resolverRoute?: "graph-symbol" | "path-search" | "repository-literal";
  consideredRecords?: number;
  reason?: string;
}

export interface CandidateFinding {
  id: string;
  sourceWorkItemIds: string[];
  sourceReviewers: SpecialistReviewerId[];
  file: string;
  line: number;
  endLine?: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  title: string;
  description: string;
  suggestion?: string;
  primarySymbol?: string;
  ruleId?: string;
  evidenceRequests: EvidenceRequest[];
  candidateConfidence: number;
}

export interface ReviewFinding {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  severity: ReviewSeverity;
  category: ReviewCategory;
  title: string;
  description: string;
  suggestion?: string;
  confidence: "verified";
  evidence: EvidenceRecord[];
  ruleId?: string;
  sourceWorkItemIds: string[];
  sourceReviewers: SpecialistReviewerId[];
}

export interface SpecialistCandidateOutcome {
  id: string;
  title: string;
  file: string;
  line: number;
  severity: ReviewSeverity;
  disposition: "verified" | "likely" | "rejected" | "insufficient_evidence" | "unadjudicated";
  reasoning?: string;
}

export interface SpecialistReview {
  reviewer: SpecialistReviewerId;
  status: "completed" | "error";
  summary: string;
  candidates: SpecialistCandidateOutcome[];
  error?: string;
}

export interface ReviewCoverage {
  selection?: "full" | "bounded";
  changedFiles: number;
  changedFilesReviewed: number;
  changedSymbols: number;
  changedSymbolsReviewed: number;
  localUnitsGenerated: number;
  localUnitsReviewed: number;
  interactionUnitsGenerated: number;
  interactionUnitsReviewed: number;
  dependencyEdgesIdentified: number;
  dependencyEdgesEligible: number;
  dependencyEdgesReviewed: number;
  evidenceRequests: number;
  evidenceRequestsAttempted?: number;
  evidenceRequestsSatisfied?: number;
  evidenceRequestsPartiallySatisfied?: number;
  evidenceRequestsUnresolved?: number;
  evidenceRequestsSkipped?: number;
  evidenceRecordsResolved?: number;
  evidenceRecordsPacked?: number;
  /** @deprecated Legacy count of packed non-anchor records. */
  evidenceResolved: number;
  evidenceGaps: number;
  globalScan: "full" | "compact" | "none";
  omissions: Array<{ kind: string; id: string; reason: string }>;
  timeout?: {
    deadlineMs: number;
    elapsedMs: number;
    callsStarted: number;
    callsCompleted: number;
    callsCancelled: number;
  };
  configuredParallelism?: number;
  effectiveParallelism?: number;
  maxObservedConcurrency?: number;
  candidateTokenBudget?: number;
  candidateTokensEstimated?: number;
  verificationTokenBudget?: number;
  verificationTokensEstimated?: number;
  selectedWorkItems?: number;
  omittedWorkItems?: number;
  timeoutOmissions?: number;
  tokenBudgetOmissions?: number;
  deadlineMs?: number;
  elapsedMs?: number;
  callsStarted?: number;
  callsCompleted?: number;
  callsCancelled?: number;
  cacheHits?: number;
  cacheMisses?: number;
  structuredRepairs?: number;
  citationRepairs?: number;
  providerInvocations?: number;
  candidateProviderMs?: number;
  verificationProviderMs?: number;
  scoutProviderMs?: number;
}

export type ReviewStatus = "completed" | "partial" | "error" | "stale";
export type AdvisoryReviewStatus = "completed" | "partial" | "provider_error" | "timeout" | "disabled";
export interface ReviewIncompleteReason {
  kind:
    | "stale-workspace"
    | "provider-failure"
    | "timeout"
    | "unfinished-work-item"
    | "unadjudicated-candidate"
    | "insufficient-evidence"
    | "likely-unpublished"
    | "material-omission";
  id?: string;
  detail: string;
}

export interface ReviewResult {
  schemaVersion: 3;
  version: string;
  snapshotId?: string;
  status: ReviewStatus;
  outcome: "clear" | "findings" | "incomplete";
  mode: ReviewMode;
  reviewPath: ReviewPath;
  findings: ReviewFinding[];
  coverage: ReviewCoverage;
  summary: string;
  timestamp: string;
  reviewer: string;
  candidates?: {
    generated: number;
    shortlisted?: number;
    adjudicated?: number;
    omitted?: number;
    verified: number;
    likely: number;
    rejected: number;
    insufficientEvidence: number;
  };
  incompleteReasons?: ReviewIncompleteReason[];
  specialists?: SpecialistReview[];
  errors?: string[];
  cacheHit?: boolean;
  scopeId?: string;
  profileHash?: string;
  strategyHash?: string;
  graphSnapshotHash?: string | null;
  traceId?: string;
  traceWarnings?: string[];
  runtime?: {
    models: ModelRoleBindings;
    inputTokens: number;
    outputTokens: number;
    concurrency: number;
  };
}
export interface QualityReviewResult {
  version: string;
  gate: GateResult;
  review: ReviewResult;
  passed: boolean;
  advisory: boolean;
  reviewMarkdown: string;
  reviewArtifact: string | null;
}
export interface QualityCompletionResult {
  version: string;
  gate: GateResult;
  review: ReviewResult | null;
  reviewEnabled: boolean;
  advisory: boolean;
  passed: boolean;
  deterministicPassed: boolean;
  completionAllowed: boolean;
  reviewMarkdown: string;
  reviewArtifact: string | null;
  advisoryReview: {
    status: AdvisoryReviewStatus;
    verdict: "pass" | "findings" | null;
    findings: ReviewFinding[];
    errors: string[];
    profileId: string | null;
    profileHash: string | null;
    startedAt?: string;
    completedAt?: string;
  };
}

export interface FixRequest {
  cwd: string;
  reviewVersion: string;
  findingIds: string[];
}
export interface FixTask {
  schemaVersion: number;
  status: "READY" | "STALE" | "INVALID";
  reviewVersion: string;
  findingIds: string[];
  findings: ReviewFinding[];
  context: Record<string, string>;
  instructions: string[];
  verification: { changed: string; review: string; full: string };
  errors: string[];
}

export interface CompletionPolicy {
  requireGate: boolean;
  requireReview: boolean;
}
export interface QualityStatus {
  schemaVersion: number;
  configured: boolean;
  root: string;
  version: string | null;
  gate: GateResult | null;
  changedGate?: GateResult | null;
  review: ReviewResult | null;
  reviewMarkdown?: string | null;
  reviewArtifact?: string | null;
  reviewRequired?: boolean;
  reviewEnabled?: boolean;
  reviewAdvisory?: boolean;
  completionAllowed: boolean;
  reason?: string;
  workspaces?: LanguageWorkspace[];
  workspaceHash?: string;
  policy?: ResolvedPolicy;
  runtime?: EngineRuntimeIdentity;
  identity?: CompletionIdentityDiagnostics;
}
export interface DoctorResult {
  capabilities: Capability[];
  config: ResolvedConfig;
  baselineExists: boolean;
  baselinePath: string;
  gitRepo: boolean;
  passed: boolean;
  warnings?: string[];
}
