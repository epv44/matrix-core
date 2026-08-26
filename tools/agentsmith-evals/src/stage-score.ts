import type { ReviewResult } from "../../../src/core/types.js";
import type { EngineExecution } from "../../../src/agentsmith/engine-types.js";
import type { AgentSmithTrace } from "../../../src/agentsmith/trace.js";
import type { EvalCase } from "./case.js";
import { findingMatches } from "./matching.js";

export type EvalStage =
  | "snapshot"
  | "graph"
  | "projection"
  | "planning"
  | "candidates"
  | "evidence"
  | "verification"
  | "aggregation"
  | "reporting";

export interface StageMetric {
  name: string;
  value: number | boolean | null;
  numerator?: number;
  denominator?: number;
  direction: "higher" | "lower" | "exact";
}

export interface StageEvaluation {
  stage: EvalStage;
  evaluation: "executed" | "observed" | "incompatible" | "not-evaluable";
  causalStatus?: "healthy" | "root-failure" | "downstream-blocked";
  blockedBy?: EvalStage[];
  metrics: StageMetric[];
  diagnostics: string[];
}

const ratio = (numerator: number, denominator: number) => (denominator ? numerator / denominator : null);
const metric = (
  name: string,
  numerator: number,
  denominator: number,
  direction: StageMetric["direction"] = "higher",
): StageMetric => ({ name, numerator, denominator, value: ratio(numerator, denominator), direction });

type Inspection = { files: Set<string>; symbols: Set<string>; edges: Set<string> };

function inspected(execution: EngineExecution): Inspection {
  return {
    files: new Set(execution.workItems.flatMap((item) => item.code.map((snippet) => snippet.file))),
    symbols: new Set(
      execution.workItems.flatMap((item) =>
        [...item.primarySymbols, ...item.relatedSymbols].flatMap((symbol) => [
          symbol.name,
          symbol.qualifiedName,
          `${symbol.file}#${symbol.qualifiedName}`,
        ]),
      ),
    ),
    edges: new Set(
      execution.workItems.flatMap((item) =>
        item.graphEdges.flatMap((edge) => [
          `${edge.source}->${edge.target ?? edge.targetText}`,
          `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`,
        ]),
      ),
    ),
  };
}

function graphInspected(execution: EngineExecution): Inspection {
  const manifest = execution.graphManifest;
  if (!manifest) return { files: new Set(), symbols: new Set(), edges: new Set() };
  return {
    files: new Set([...manifest.changedSymbols, ...manifest.nodes].map((symbol) => symbol.file)),
    symbols: new Set(
      [...manifest.changedSymbols, ...manifest.nodes].flatMap((symbol) => [
        symbol.name,
        symbol.qualifiedName,
        `${symbol.file}#${symbol.qualifiedName}`,
      ]),
    ),
    edges: new Set(
      manifest.edges.flatMap((edge) => [
        `${edge.source}->${edge.target ?? edge.targetText}`,
        `${edge.source}->${edge.target ?? edge.targetText}:${edge.kind}`,
      ]),
    ),
  };
}

function canonicalChangeKinds(trace: AgentSmithTrace): Map<string, string> {
  const kinds = new Map(trace.scope.manifest.map((item) => [item.path, item.changeKind as string]));
  let current: string | undefined;
  for (const line of trace.scope.diff.split("\n")) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      current = header[2];
      kinds.set(current, header[1] === header[2] ? "modified" : "renamed");
    } else if (current && line.startsWith("new file mode ")) kinds.set(current, "added");
    else if (current && line.startsWith("deleted file mode ")) kinds.set(current, "deleted");
  }
  return kinds;
}

function targetMetrics(
  targets: {
    files: string[];
    symbols: string[];
    edges: string[];
    forbiddenFiles: string[];
    forbiddenSymbols: string[];
    forbiddenEdges: string[];
  },
  actual: Inspection,
) {
  return (["files", "symbols", "edges"] as const).map((kind) => {
    const matched = targets[kind].filter((target) => actual[kind].has(target));
    const forbiddenKey = `forbidden${kind[0].toUpperCase()}${kind.slice(1)}` as
      "forbiddenFiles" | "forbiddenSymbols" | "forbiddenEdges";
    const forbidden = targets[forbiddenKey].filter((target) => actual[kind].has(target));
    return {
      metric: metric(`${kind}Recall`, matched.length, targets[kind].length),
      forbiddenMetric: {
        name: `forbidden${kind[0].toUpperCase()}${kind.slice(1)}`,
        value: forbidden.length,
        direction: "lower" as const,
      },
      missing: targets[kind].filter((target) => !actual[kind].has(target)),
      forbidden,
    };
  });
}

function graphPathExists(
  execution: EngineExecution,
  expected: { from: string; to: string; maxHops: number; edgeKinds: string[] },
): boolean {
  const edges = execution.graphManifest?.edges ?? [];
  const queue: Array<{ node: string; hops: number }> = [{ node: expected.from, hops: 0 }];
  const visited = new Set([expected.from]);
  while (queue.length) {
    const current = queue.shift()!;
    if (current.node === expected.to) return true;
    if (current.hops >= expected.maxHops) continue;
    for (const edge of edges) {
      if (edge.source !== current.node || (expected.edgeKinds.length && !expected.edgeKinds.includes(edge.kind)))
        continue;
      const target = edge.target ?? edge.targetText;
      if (visited.has(target)) continue;
      visited.add(target);
      queue.push({ node: target, hops: current.hops + 1 });
    }
  }
  return false;
}

type CandidateExpectation = NonNullable<EvalCase["expectations"]["candidates"]>["items"][number];

function candidateMatches(
  actual: { file: string; line: number; endLine?: number; category: string; severity?: string; title: string },
  expected: CandidateExpectation,
) {
  const end = actual.endLine ?? actual.line;
  if (actual.file !== expected.file || end < expected.lineStart || actual.line > expected.lineEnd) return false;
  if (expected.category && actual.category !== expected.category) return false;
  if (expected.severity && actual.severity !== expected.severity) return false;
  return !expected.titleContains || actual.title.toLowerCase().includes(expected.titleContains.toLowerCase());
}

function candidateExpectations(definition: EvalCase): CandidateExpectation[] {
  return definition.expectations.verification?.candidates ?? definition.expectations.candidates?.items ?? [];
}

export function evaluateStages(opts: {
  definition: EvalCase;
  trace: AgentSmithTrace;
  execution: EngineExecution;
  result: ReviewResult;
  tier: "stage" | "recorded" | "isolated" | "live";
  hermetic: boolean;
  selected?: EvalStage[];
  candidateExecution?: EngineExecution;
  reportMarkdown?: string;
}): StageEvaluation[] {
  const { definition, trace, execution, result } = opts;
  const chosen = new Set<EvalStage>(
    opts.selected ?? [
      "snapshot",
      "graph",
      "projection",
      "planning",
      "candidates",
      "evidence",
      "verification",
      "aggregation",
      "reporting",
    ],
  );
  const evaluation = (stage: EvalStage) => {
    if (stage === "snapshot") return "observed" as const;
    if (opts.tier === "stage" && ["graph", "projection", "planning"].includes(stage))
      return opts.hermetic ? ("executed" as const) : ("observed" as const);
    return "executed" as const;
  };
  const values: StageEvaluation[] = [];
  const push = (value: StageEvaluation) => {
    if (chosen.has(value.stage)) values.push(value);
  };

  const snapshot = definition.expectations.snapshot;
  if (!snapshot) push({ stage: "snapshot", evaluation: "not-evaluable", metrics: [], diagnostics: ["no labels"] });
  else {
    const actual = canonicalChangeKinds(trace);
    const matched = snapshot.files.filter(
      (item) => actual.get(item.path) && (!item.changeKind || actual.get(item.path) === item.changeKind),
    );
    push({
      stage: "snapshot",
      evaluation: evaluation("snapshot"),
      metrics: [
        metric("fileRecall", matched.length, snapshot.files.length),
        metric("filePrecision", matched.length, actual.size),
        {
          name: "fixtureValidated",
          value: opts.hermetic,
          direction: "exact",
        },
      ],
      diagnostics: snapshot.files.filter((item) => !matched.includes(item)).map((item) => `missing ${item.path}`),
    });
  }

  for (const stage of ["graph", "planning"] as const) {
    const targets = definition.expectations[stage];
    if (!targets) {
      push({ stage, evaluation: "not-evaluable", metrics: [], diagnostics: ["no labels"] });
      continue;
    }
    const actual = stage === "graph" ? graphInspected(execution) : inspected(execution);
    const scored = targetMetrics(targets, actual);
    const metrics = scored.flatMap((item) => [item.metric, item.forbiddenMetric]);
    const diagnostics = scored.flatMap((item) => [
      ...item.missing.map((target) => `missing ${target}`),
      ...item.forbidden.map((target) => `forbidden ${target}`),
    ]);
    if (stage === "graph") {
      const matchedPaths = targets.paths.filter((item) => graphPathExists(execution, item));
      metrics.push(metric("pathRecall", matchedPaths.length, targets.paths.length));
      const exactEdges = new Set(
        (execution.graphManifest?.edges ?? [])
          .filter((edge) => edge.target !== null && edge.confidence === "exact")
          .map((edge) => `${edge.source}->${edge.target}:${edge.kind}`),
      );
      metrics.push(
        metric(
          "labeledExactEdgeRate",
          targets.edges.filter((edge) => exactEdges.has(edge)).length,
          targets.edges.length,
        ),
      );
      metrics.push({
        name: "unresolvedTargetRate",
        value: ratio(
          execution.graphManifest?.edges.filter((edge) => edge.target === null).length ?? 0,
          execution.graphManifest?.edges.length ?? 0,
        ),
        direction: "lower",
      });
      const changedKeys = new Set(
        (execution.graphManifest?.changedSymbols ?? []).map((symbol) => `${symbol.file}:${symbol.qualifiedName}`),
      );
      const edgeKinds = [...new Set((execution.graphManifest?.edges ?? []).map((edge) => edge.kind))].sort();
      for (const kind of edgeKinds) {
        const byKind = (execution.graphManifest?.edges ?? []).filter((edge) => edge.kind === kind);
        const changedNeighborhood = byKind.filter(
          (edge) => changedKeys.has(edge.source) || Boolean(edge.target && changedKeys.has(edge.target)),
        );
        metrics.push({
          name: `unresolvedTargetRate.${kind}`,
          value: ratio(byKind.filter((edge) => edge.target === null).length, byKind.length),
          direction: "lower",
        });
        metrics.push({
          name: `exactResolutionRate.${kind}`,
          value: ratio(
            byKind.filter((edge) => edge.target !== null && edge.confidence === "exact").length,
            byKind.length,
          ),
          direction: "higher",
        });
        metrics.push({
          name: `changedNeighborhoodExactRate.${kind}`,
          value: ratio(
            changedNeighborhood.filter((edge) => edge.target !== null && edge.confidence === "exact").length,
            changedNeighborhood.length,
          ),
          direction: "higher",
        });
      }
      metrics.push({
        name: "snapshotReady",
        value: execution.graphSnapshot?.state === "READY",
        direction: "exact",
      });
      diagnostics.push(
        ...targets.paths
          .filter((item) => !matchedPaths.includes(item))
          .map((item) => `missing path ${item.from}->${item.to} within ${item.maxHops} hop(s)`),
      );
    }
    if (stage === "planning" && "route" in targets && targets.route)
      metrics.push({ name: "routeCorrect", value: execution.route.mode === targets.route, direction: "exact" });
    if (stage === "planning") {
      const unique = new Set(execution.workItems.map((item) => item.id)).size;
      metrics.push(metric("uniqueWorkItemRate", unique, execution.workItems.length));
      metrics.push({
        name: "candidateBudgetRespected",
        value: (result.coverage.candidateTokensEstimated ?? 0) <= (result.coverage.candidateTokenBudget ?? Infinity),
        direction: "exact",
      });
      const optional = "optionalTargets" in targets ? targets.optionalTargets : { files: [], symbols: [], edges: [] };
      const optionalScored = targetMetrics(
        {
          ...optional,
          forbiddenFiles: [],
          forbiddenSymbols: [],
          forbiddenEdges: [],
        },
        actual,
      );
      metrics.push(
        ...optionalScored.map((item) => ({
          ...item.metric,
          name: `optional${item.metric.name[0].toUpperCase()}${item.metric.name.slice(1)}`,
        })),
      );
    }
    push({ stage, evaluation: evaluation(stage), metrics, diagnostics });
  }

  const projection = definition.expectations.projection;
  if (!projection) push({ stage: "projection", evaluation: "not-evaluable", metrics: [], diagnostics: ["no labels"] });
  else {
    const snippets = execution.projection.code;
    const matched = projection.requiredSnippets.filter((expected) =>
      snippets.some(
        (actual) =>
          actual.file === expected.file &&
          (!expected.lineStart || actual.endLine >= expected.lineStart) &&
          (!expected.lineEnd || actual.startLine <= expected.lineEnd) &&
          expected.contains.every((term) => actual.content.toLowerCase().includes(term.toLowerCase())),
      ),
    );
    const forbiddenSnippets = snippets.filter((snippet) => projection.forbiddenFiles.includes(snippet.file));
    const forbiddenFiles = [...new Set(forbiddenSnippets.map((snippet) => snippet.file))];
    const forbiddenContent = projection.forbiddenContent.filter((term) =>
      snippets.some((snippet) => snippet.content.toLowerCase().includes(term.toLowerCase())),
    );
    const duplicateSnippets = snippets.length - new Set(snippets.map((item) => item.id)).size;
    const omittedTokens = execution.projection.audit
      .filter((item) => item.kind === "code" && item.status !== "selected")
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    const totalCodeTokens = execution.projection.audit
      .filter((item) => item.kind === "code")
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
    const projectedCodeTokens = snippets.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
    const forbiddenTokens = forbiddenSnippets.reduce((sum, item) => sum + (item.estimatedTokens ?? 0), 0);
    push({
      stage: "projection",
      evaluation: evaluation("projection"),
      metrics: [
        metric("requiredSnippetRecall", matched.length, projection.requiredSnippets.length),
        { name: "forbiddenFiles", value: forbiddenFiles.length, direction: "lower" },
        { name: "forbiddenTokenRate", value: ratio(forbiddenTokens, projectedCodeTokens), direction: "lower" },
        { name: "forbiddenContent", value: forbiddenContent.length, direction: "lower" },
        { name: "duplicateSnippets", value: duplicateSnippets, direction: "lower" },
        { name: "omittedCodeTokenRate", value: ratio(omittedTokens, totalCodeTokens), direction: "lower" },
      ],
      diagnostics: [
        ...projection.requiredSnippets
          .filter((item) => !matched.includes(item))
          .map((item) => `missing snippet ${item.file}`),
        ...forbiddenFiles.map((item) => `forbidden projection file ${item}`),
        ...forbiddenContent.map((item) => `forbidden projection content ${item}`),
      ],
    });
  }

  const expectedCandidates = candidateExpectations(definition);
  const candidateStageExecution = opts.candidateExecution ?? execution;
  if (opts.tier === "stage" || !definition.expectations.candidates) {
    push({
      stage: "candidates",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "stage tier does not invoke candidate models" : "no labels"],
    });
  } else {
    const desired = expectedCandidates.filter((expected) => expected.expectedPresence);
    const forbidden = expectedCandidates.filter((expected) => !expected.expectedPresence);
    const matched = desired.filter((expected) =>
      candidateStageExecution.candidates.some((actual) => candidateMatches(actual, expected)),
    );
    const generatedForbidden = forbidden.filter((expected) =>
      candidateStageExecution.candidates.some((actual) => candidateMatches(actual, expected)),
    );
    const anchored = candidateStageExecution.candidates.filter((candidate) =>
      trace.scope.changedFiles.includes(candidate.file),
    ).length;
    const requestsComplete = desired.filter((expected) => {
      const actual = candidateStageExecution.candidates.find((candidate) => candidateMatches(candidate, expected));
      return expected.requiredEvidenceKinds.every((kind) =>
        actual?.evidenceRequests.some((request) => request.kind === kind),
      );
    }).length;
    const reasoningComplete = desired.filter((expected) => {
      const actual = candidateStageExecution.candidates.find((candidate) => candidateMatches(candidate, expected));
      const reasoning = `${actual?.title ?? ""} ${actual?.description ?? ""}`.toLowerCase();
      return (
        expected.requiredReasoningTerms.every((term) => reasoning.includes(term.toLowerCase())) &&
        expected.forbiddenReasoningTerms.every((term) => !reasoning.includes(term.toLowerCase()))
      );
    }).length;
    push({
      stage: "candidates",
      evaluation: evaluation("candidates"),
      metrics: [
        metric("expectedCandidateRecall", matched.length, desired.length),
        { name: "forbiddenCandidates", value: generatedForbidden.length, direction: "lower" },
        metric("anchorValidity", anchored, candidateStageExecution.candidates.length),
        metric("evidenceRequestCompleteness", requestsComplete, desired.length),
        metric("reasoningTermAccuracy", reasoningComplete, desired.length),
      ],
      diagnostics: [
        ...desired.filter((item) => !matched.includes(item)).map((item) => `missing ${item.id}`),
        ...generatedForbidden.map((item) => `forbidden candidate ${item.id}`),
      ],
    });
  }

  const evidenceLabels = definition.expectations.evidence?.requests;
  if (opts.tier === "stage" || !evidenceLabels) {
    push({
      stage: "evidence",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "no candidates in deterministic stage tier" : "no labels"],
    });
  } else {
    let statusMatches = 0;
    let expectedFiles = 0;
    let matchedFiles = 0;
    let forbiddenFiles = 0;
    let expectedSymbols = 0;
    let matchedSymbols = 0;
    let requiredContent = 0;
    let matchedContent = 0;
    let forbiddenContent = 0;
    const diagnostics: string[] = [];
    for (const label of evidenceLabels) {
      const candidateLabel = expectedCandidates.find((item) => item.id === label.candidate);
      const candidate = candidateLabel
        ? execution.candidates.find((item) => candidateMatches(item, candidateLabel))
        : execution.candidates.find((item) => item.id === label.candidate);
      const outcomes = candidate ? (execution.evidenceOutcomes?.[candidate.id] ?? []) : [];
      const outcome = outcomes.find((item) => item.request.kind === label.kind);
      if (outcome?.status === label.status) statusMatches += 1;
      const files = new Set(outcome?.records.map((record) => record.file) ?? []);
      expectedFiles += label.expectedFiles.length;
      matchedFiles += label.expectedFiles.filter((file) => files.has(file)).length;
      forbiddenFiles += label.forbiddenFiles.filter((file) => files.has(file)).length;
      const symbols = new Set(outcome?.records.map((record) => record.symbol).filter(Boolean) ?? []);
      expectedSymbols += label.expectedSymbols.length;
      matchedSymbols += label.expectedSymbols.filter((symbol) =>
        [...symbols].some((actual) => actual === symbol || actual?.endsWith(`.${symbol}`)),
      ).length;
      const snippets = outcome?.records.map((record) => record.snippet.toLowerCase()) ?? [];
      requiredContent += label.requiredContent.length;
      matchedContent += label.requiredContent.filter((term) =>
        snippets.some((snippet) => snippet.includes(term.toLowerCase())),
      ).length;
      forbiddenContent += label.forbiddenContent.filter((term) =>
        snippets.some((snippet) => snippet.includes(term.toLowerCase())),
      ).length;
      if (!outcome) diagnostics.push(`missing ${label.candidate}:${label.kind}`);
    }
    push({
      stage: "evidence",
      evaluation: evaluation("evidence"),
      metrics: [
        metric("resolutionStatusAccuracy", statusMatches, evidenceLabels.length),
        metric("requiredFileRecall", matchedFiles, expectedFiles),
        metric("requiredSymbolRecall", matchedSymbols, expectedSymbols),
        metric("requiredContentRecall", matchedContent, requiredContent),
        { name: "forbiddenRecords", value: forbiddenFiles, direction: "lower" },
        { name: "forbiddenContent", value: forbiddenContent, direction: "lower" },
      ],
      diagnostics,
    });
  }

  const verificationLabels = definition.expectations.verification?.candidates;
  if (opts.tier === "stage" || !verificationLabels) {
    push({
      stage: "verification",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "stage tier does not invoke verifier models" : "no labels"],
    });
  } else {
    let verdictMatches = 0;
    let falseVerified = 0;
    let cited = 0;
    let validCitations = 0;
    let reasoningMatches = 0;
    const diagnostics: string[] = [];
    const applicable = verificationLabels.filter(
      (expected) =>
        expected.expectedPresence || execution.candidates.some((candidate) => candidateMatches(candidate, expected)),
    );
    const citationApplicable = applicable.filter((expected) => expected.expectedVerdict === "verified");
    const reasoningApplicable = applicable.filter(
      (expected) => expected.requiredReasoningTerms.length || expected.forbiddenReasoningTerms.length,
    );
    for (const expected of applicable) {
      const candidate = execution.candidates.find((item) => candidateMatches(item, expected));
      const verdict = candidate && execution.verification.find((item) => item.candidateId === candidate.id);
      if (verdict?.verdict === expected.expectedVerdict) verdictMatches += 1;
      if (expected.expectedVerdict !== "verified" && verdict?.verdict === "verified") falseVerified += 1;
      if (expected.expectedVerdict === "verified" && verdict?.supportingEvidenceIds.length) cited += 1;
      const evidenceIds = new Set(execution.evidence[candidate?.id ?? ""]?.map((record) => record.id) ?? []);
      if (
        expected.expectedVerdict === "verified" &&
        verdict?.supportingEvidenceIds.length &&
        verdict.supportingEvidenceIds.every((id) => evidenceIds.has(id))
      )
        validCitations += 1;
      const reasoning = verdict?.reasoningSummary?.toLowerCase() ?? "";
      if (
        verdict &&
        (expected.requiredReasoningTerms.length > 0 || expected.forbiddenReasoningTerms.length > 0) &&
        expected.requiredReasoningTerms.every((term) => reasoning.includes(term.toLowerCase())) &&
        expected.forbiddenReasoningTerms.every((term) => !reasoning.includes(term.toLowerCase()))
      )
        reasoningMatches += 1;
      if (!verdict) diagnostics.push(`unadjudicated ${expected.id}`);
    }
    push({
      stage: "verification",
      evaluation: evaluation("verification"),
      metrics: [
        metric("verdictAccuracy", verdictMatches, applicable.length),
        { name: "falseVerifications", value: falseVerified, direction: "lower" },
        metric("citationRate", cited, citationApplicable.length),
        metric("citationValidity", validCitations, citationApplicable.length),
        metric("reasoningTermAccuracy", reasoningMatches, reasoningApplicable.length),
      ],
      diagnostics,
    });
  }

  const aggregation = definition.expectations.aggregation;
  if (opts.tier === "stage" || !aggregation) {
    push({
      stage: "aggregation",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "model-dependent inputs are not available in stage tier" : "no labels"],
    });
  } else {
    const unmatched = new Set(result.findings.map((_, index) => index));
    let truePositive = 0;
    for (const expected of aggregation.findings) {
      const index = [...unmatched].find((candidate) => findingMatches(result.findings[candidate], expected));
      if (index === undefined) continue;
      unmatched.delete(index);
      truePositive += 1;
    }
    const precision = ratio(truePositive, truePositive + unmatched.size) ?? (aggregation.findings.length ? 0 : 1);
    const recall = ratio(truePositive, aggregation.findings.length) ?? 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    push({
      stage: "aggregation",
      evaluation: evaluation("aggregation"),
      metrics: [
        { name: "precision", value: precision, direction: "higher" },
        { name: "recall", value: recall, direction: "higher" },
        { name: "f1", value: f1, direction: "higher" },
        {
          name: "outcomeCorrect",
          value: aggregation.outcome ? result.outcome === aggregation.outcome : null,
          direction: "exact",
        },
        {
          name: "statusCorrect",
          value: aggregation.status ? result.status === aggregation.status : null,
          direction: "exact",
        },
      ],
      diagnostics: [],
    });
  }

  const reporting = definition.expectations.reporting;
  if (opts.tier === "stage" || !reporting)
    push({
      stage: "reporting",
      evaluation: "not-evaluable",
      metrics: [],
      diagnostics: [opts.tier === "stage" ? "model-dependent result is not available in stage tier" : "no labels"],
    });
  else {
    const rendered = opts.reportMarkdown ?? "";
    const matched = reporting.requiredSections.filter((section) => rendered.includes(section));
    const coverageConsistent =
      result.coverage.changedFilesReviewed <= result.coverage.changedFiles &&
      result.coverage.changedSymbolsReviewed <= result.coverage.changedSymbols;
    const provenanceComplete = Boolean(
      execution.graphSnapshot?.schemaVersion &&
      Object.keys(execution.graphSnapshot.providerVersions).length &&
      execution.modelProfiles.candidate &&
      execution.modelProfiles.verifier,
    );
    push({
      stage: "reporting",
      evaluation: evaluation("reporting"),
      metrics: [
        metric("requiredContent", matched.length, reporting.requiredSections.length),
        { name: "coverageConsistent", value: coverageConsistent, direction: "exact" },
        { name: "provenanceComplete", value: provenanceComplete, direction: "exact" },
      ],
      diagnostics: reporting.requiredSections
        .filter((item) => !matched.includes(item))
        .map((item) => `missing ${item}`),
    });
  }
  const timingKey: Record<EvalStage, keyof NonNullable<EngineExecution["stageTimingsMs"]>> = {
    snapshot: "snapshot",
    graph: "graph",
    projection: "projection",
    planning: "planning",
    candidates: "candidateGeneration",
    evidence: "evidence",
    verification: "verification",
    aggregation: "aggregation",
    reporting: "reporting",
  };
  for (const stage of values) {
    const stageExecution = stage.stage === "candidates" ? candidateStageExecution : execution;
    const wallMs = stageExecution.stageTimingsMs?.[timingKey[stage.stage]];
    stage.metrics.push({ name: "wallMs", value: wallMs ?? null, direction: "lower" });
    if (stage.stage === "candidates")
      stage.metrics.push({
        name: "providerMs",
        value: candidateStageExecution.coverage?.candidateProviderMs ?? null,
        direction: "lower",
      });
    if (stage.stage === "verification")
      stage.metrics.push({
        name: "providerMs",
        value: result.coverage.verificationProviderMs ?? null,
        direction: "lower",
      });
  }

  const expectedPositive = expectedCandidates.filter((candidate) => candidate.expectedPresence);
  const candidateMatched = expectedPositive.filter((expected) =>
    candidateStageExecution.candidates.some((candidate) => candidateMatches(candidate, expected)),
  );
  const candidateFailure =
    opts.tier !== "stage" && expectedPositive.length > 0 && candidateMatched.length < expectedPositive.length;
  const isolateDownstream = opts.tier === "isolated";
  const labeledEvidenceLabels = definition.expectations.evidence?.requests ?? [];
  const evidenceFailure = labeledEvidenceLabels.some((label) => {
    const expected = expectedCandidates.find((candidate) => candidate.id === label.candidate);
    const actual = expected && execution.candidates.find((candidate) => candidateMatches(candidate, expected));
    const outcome = actual && execution.evidenceOutcomes?.[actual.id]?.find((item) => item.request.kind === label.kind);
    return !outcome || outcome.status !== label.status;
  });
  const labeledVerificationLabels = definition.expectations.verification?.candidates ?? [];
  const verificationFailure = labeledVerificationLabels.some((expected) => {
    const actual = execution.candidates.find((candidate) => candidateMatches(candidate, expected));
    const verdict = actual && execution.verification.find((item) => item.candidateId === actual.id);
    return Boolean(actual && verdict && verdict.verdict !== expected.expectedVerdict);
  });
  const aggregationFailure = Boolean(
    definition.expectations.aggregation?.outcome && result.outcome !== definition.expectations.aggregation.outcome,
  );
  for (const stage of values) {
    if (stage.evaluation === "not-evaluable" || stage.evaluation === "incompatible") continue;
    if (stage.stage === "candidates") {
      stage.causalStatus = candidateFailure ? "root-failure" : "healthy";
    } else if (stage.stage === "evidence") {
      stage.causalStatus =
        !isolateDownstream && candidateFailure ? "downstream-blocked" : evidenceFailure ? "root-failure" : "healthy";
      if (!isolateDownstream && candidateFailure) stage.blockedBy = ["candidates"];
    } else if (stage.stage === "verification") {
      stage.causalStatus =
        (!isolateDownstream && candidateFailure) || evidenceFailure
          ? "downstream-blocked"
          : verificationFailure
            ? "root-failure"
            : "healthy";
      if (!isolateDownstream && candidateFailure) stage.blockedBy = ["candidates"];
      else if (evidenceFailure) stage.blockedBy = ["evidence"];
    } else if (stage.stage === "aggregation") {
      stage.causalStatus =
        (!isolateDownstream && candidateFailure) || evidenceFailure || verificationFailure
          ? "downstream-blocked"
          : aggregationFailure
            ? "root-failure"
            : "healthy";
      if (!isolateDownstream && candidateFailure) stage.blockedBy = ["candidates"];
      else if (evidenceFailure) stage.blockedBy = ["evidence"];
      else if (verificationFailure) stage.blockedBy = ["verification"];
    } else if (stage.stage === "reporting") {
      stage.causalStatus = aggregationFailure ? "downstream-blocked" : "healthy";
      if (aggregationFailure) stage.blockedBy = ["aggregation"];
    } else {
      stage.causalStatus = stage.diagnostics.length ? "root-failure" : "healthy";
    }
  }
  return values;
}

function display(value: number | boolean | null): string {
  if (value === null) return "N/A";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function formatStageScorecard(stages: StageEvaluation[]): string[] {
  return [
    "| Stage | Evaluation | Causal status | Metrics | Diagnostics |",
    "|---|---|---|---|---|",
    ...stages.map(
      (stage) =>
        `| ${stage.stage} | ${stage.evaluation} | ${stage.causalStatus ?? "N/A"}${stage.blockedBy?.length ? ` (${stage.blockedBy.join(", ")})` : ""} | ${stage.metrics.map((item) => `${item.name}=${display(item.value)}`).join(", ") || "N/A"} | ${stage.diagnostics.join("; ") || "—"} |`,
    ),
  ];
}
