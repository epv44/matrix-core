import type { PipelineMetricSummary, PipelineStageSummary } from "./suite.js";

/** Deterministic, dependency-free renderer for AgentSmith suite reports. */
export type EvalHtmlInput = { suite?: unknown; run?: unknown; baseline?: unknown; comparison?: unknown; [key: string]: unknown };
type Dict = Record<string, unknown>;

const esc = (value: unknown) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
const dict = (value: unknown): Dict =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};

function displayStatus(value: unknown): string {
  const normalized = String(value ?? "N/A").toUpperCase().replaceAll("_", " ");
  if (normalized === "NOT APPLICABLE") return "N/A";
  return ["PASS", "FAIL", "PARTIAL", "INCOMPLETE", "ERROR", "INCOMPATIBLE", "BLOCKED", "NOT EVALUABLE", "COMPLETED", "STALE", "DRAFT", "N/A"].includes(normalized)
    ? normalized
    : "N/A";
}

function statusClass(value: string): string {
  return value.toLowerCase().replaceAll(" ", "-");
}

function humanize(name: string): string {
  const known: Record<string, string> = {
    candidateFindingPrecision: "Candidate precision",
    candidateFindingRecall: "Candidate recall",
    expectedCandidateRecall: "Expected candidate recall",
    changedFileOverlap: "Changed-file overlap",
    changedRegionOverlap: "Changed-region overlap",
    categoryCompatibility: "Category compatibility",
    severityCompatibility: "Severity compatibility",
    triggeringValueRecall: "Triggering-value recall",
    violatedInvariantTermRecall: "Violated-invariant term recall",
    observableImpactTermRecall: "Observable-impact term recall",
    titleSimilarity: "Title similarity (diagnostic)",
    anchorValidityDiagnostic: "Anchor validity (diagnostic)",
    anchorDistance: "Anchor distance",
    evidenceRequestCompletenessDiagnostic: "Evidence-request completeness",
    evidenceRequestLocatorValidity: "Evidence-request locator validity",
    evidenceRequestLocatorScopeValidity: "Evidence-request scope validity",
    strictOracleOnlyRejection: "Semantic candidate rejected by strict oracle",
    filePrecision: "File precision",
    fileRecall: "File recall",
    forbiddenTokenRate: "Forbidden token rate",
    fixtureValidated: "Fixture validation",
    grounding_validity: "Grounding validity",
    grounding_specificity: "Grounding specificity",
    production_acceptance_accuracy: "Production acceptance accuracy",
    requiredContent: "Required content",
    requiredContentRecall: "Required content recall",
    requiredFileRecall: "Required file recall",
    requiredSnippetRecall: "Required snippet recall",
    requiredSymbolRecall: "Required symbol recall",
    riskMustOutrankAccuracy: "Risk must-outrank accuracy",
    riskPriorityAssertionAccuracy: "Risk priority accuracy",
    riskRankOrderRecall: "Risk rank-order recall",
    degreeOrderingAccuracy: "Degree ordering accuracy",
    microEdgeRecall: "Micro edge recall",
    microEdgePrecision: "Micro edge precision",
    macroAdjacencyRecall: "Macro adjacency recall",
    minimumNodeAdjacencyRecall: "Minimum node adjacency recall",
    emptyAdjacencyExact: "Empty adjacency exactness",
    fanInAccuracy: "Fan-in accuracy",
    fanOutAccuracy: "Fan-out accuracy",
    neighborDegreeAccuracy: "Neighbor-degree accuracy",
    directedIncidentDegreeAccuracy: "Directed incident-degree accuracy",
    highDegreeNodeRecall: "High-degree node recall",
    riskFactorAvailability: "Risk-factor availability",
    riskFactorValueAccuracy: "Risk-factor value accuracy",
    graphFactorCoverage: "Graph-factor coverage",
    candidateUnitCoverage: "Candidate-unit coverage",
    selectionConstrainedRunRecall: "Constrained selection recall",
    selectionExpectedRecall: "Selection recall",
    selectionRequiredReservedRecall: "Required reservation recall",
    selectionRankOrderPreserved: "Incoming rank order preserved",
    budgetLimitedOmissionCount: "Budget-limited omissions",
    ordinaryOmissionCount: "Ordinary omissions",
    forbiddenSelectionFiles: "Forbidden selected files",
    selectionTokenBudgetRespected: "Selection token budget",
    selectionWorkItemBudgetRespected: "Selection work-item budget",
    verification_accuracy: "Verification accuracy",
    verifiedFindingPrecision: "Verified finding precision",
    verifiedFindingRecall: "Verified finding recall",
  };
  if (known[name]) return known[name];
  return name
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\.([a-z])/g, (_, letter: string) => ` · ${letter.toUpperCase()}`)
    .replace(/^./, (letter) => letter.toUpperCase());
}

const meanings: Record<string, string> = {
  "snapshot.fileRecall": "Expected changed files found.",
  "snapshot.filePrecision": "Reported changed files that were actually changed.",
  "snapshot.fixtureValidated": "Frozen repository fixture passed validation.",
  "graph.filesRecall": "Expected graph files resolved.",
  "graph.symbolsRecall": "Expected graph symbols resolved.",
  "graph.edgesRecall": "Expected dependency edges resolved.",
  "graph.pathRecall": "Expected dependency paths found.",
  "graph.exactResolutionRate.calls": "Call edges resolved to exact targets.",
  "graph.unresolvedTargetRate.calls": "Call edges without a resolved target.",
  "graph.microEdgeRecall": "Canonical expected edges retrieved within the labeled scope.",
  "graph.microEdgePrecision": "Retrieved canonical edges that are expected within the labeled scope.",
  "graph.macroAdjacencyRecall": "Mean per-node recall across exhaustively labeled adjacency sets.",
  "graph.minimumNodeAdjacencyRecall": "Worst per-node recall across exhaustively labeled adjacency sets.",
  "graph.neighborDegreeAccuracy": "Nodes whose canonical unique-neighbor degree is exact.",
  "graph.fanInAccuracy": "Nodes whose canonical incoming-neighbor count is exact.",
  "graph.fanOutAccuracy": "Nodes whose canonical outgoing-neighbor count is exact.",
  "graph.directedIncidentDegreeAccuracy": "Nodes whose canonical directed incident degree is exact.",
  "graph.highDegreeNodeRecall": "High-degree labeled nodes whose degree is exactly recovered.",
  "planning.candidateUnitCoverage": "Unique planner units retained in the complete planning output.",
  "planning.riskFactorAvailability": "Expected planning risk-factor values that are present, including zero values.",
  "planning.riskFactorValueAccuracy": "Planning risk-factor values exactly matching the fixture oracle.",
  "planning.graphFactorCoverage": "Labeled nodes with a complete set of graph factors in Planning.",
  "planning.routeCorrect": "Expected review route selected.",
  "ranking.riskRankOrderRecall": "Expected risk ordering preserved over the complete planner output.",
  "ranking.riskMustOutrankAccuracy": "Required risk outranking assertions satisfied.",
  "ranking.degreeOrderingAccuracy": "Explicit higher-degree pair assertions satisfied.",
  "ranking.riskPriorityAssertionAccuracy": "Required priority and factor assertions satisfied.",
  "selection.selectionExpectedRecall": "Expected eligible work items included before constrained-oracle analysis.",
  "selection.selectionConstrainedRunRecall": "Expected feasible work items included after reservation and budget constraints.",
  "selection.selectionRequiredReservedRecall": "Required reserved IDs or kinds preserved by Selection.",
  "selection.selectionRankOrderPreserved": "Selected items remain in the order received from Ranking.",
  "selection.budgetLimitedOmissionCount": "Eligible units omitted because the hard token budget could not fit them.",
  "selection.ordinaryOmissionCount": "Eligible units omitted for ordinary ranking or reservation reasons.",
  "selection.forbiddenSelectionFiles": "Files explicitly excluded from the selected context.",
  "selection.selectionWorkItemBudgetRespected": "Selected work items stayed within the hard budget.",
  "selection.selectionTokenBudgetRespected": "Selected context stayed within the hard token budget.",
  "projection.requiredSnippetRecall": "Required code snippets included in context.",
  "projection.omittedCodeTokenRate": "Code tokens omitted during projection.",
  "projection.forbiddenTokenRate": "Projected tokens from forbidden context.",
  "candidates.expectedCandidateRecall": "Expected candidate labels matched.",
  "candidates.candidateFindingRecall": "Expected findings found before verification.",
  "candidates.candidateFindingPrecision": "Generated candidates that match expected findings.",
  "candidates.anchorValidity": "Candidates anchored to valid changed files.",
  "candidates.changedFileOverlap": "Expected candidates with a generated candidate in the expected changed file.",
  "candidates.changedRegionOverlap": "Expected candidates whose generated candidate overlaps the expected changed region.",
  "candidates.categoryCompatibility": "Nearest generated candidates with the expected category.",
  "candidates.severityCompatibility": "Nearest generated candidates with the expected severity.",
  "candidates.triggeringValueRecall": "Required concrete trigger terms found in candidate title or description; diagnostic only.",
  "candidates.violatedInvariantTermRecall": "Expected invariant terms found in candidate title or description; diagnostic only.",
  "candidates.observableImpactTermRecall": "Expected observable-impact terms found in candidate title or description; diagnostic only.",
  "candidates.titleSimilarity": "Token similarity to the expected title label; never used for strict matching.",
  "candidates.anchorValidityDiagnostic": "Generated candidates with valid changed-scope anchors; diagnostic only.",
  "candidates.anchorDistance": "Mean line distance from the nearest same-file candidate to the expected anchor.",
  "candidates.evidenceRequestCompletenessDiagnostic": "Required evidence kinds requested by the nearest candidate.",
  "candidates.evidenceRequestLocatorValidity": "Evidence requests whose symbol or literal locator is structurally valid.",
  "candidates.evidenceRequestLocatorScopeValidity": "Syntactically valid evidence locators found within the frozen ReviewScope contents; this is not proof of resolver satisfaction.",
  "candidates.strictOracleOnlyRejection": "Semantically relevant candidates that fail the strict oracle; diagnostic only.",
  "evidence.resolutionStatusAccuracy": "Evidence resolution statuses matched expectations.",
  "evidence.requiredFileRecall": "Required evidence files retrieved.",
  "evidence.requiredSymbolRecall": "Required evidence symbols retrieved.",
  "evidence.requiredContentRecall": "Required evidence content retrieved.",
  "verification.verification_accuracy": "Verifier verdicts matched expectations.",
  "verification.citationRate": "Expected verified candidates cited supporting evidence.",
  "verification.grounding_validity": "Citations referred to existing evidence records.",
  "verification.grounding_specificity": "Citations used canonical records for the request.",
  "verification.production_acceptance_accuracy": "Candidates accepted for publication correctly.",
  "verification.verifiedFindingRecall": "Expected findings published after verification.",
  "verification.verifiedFindingPrecision": "Published findings that match expected findings.",
  "aggregation.precision": "Final findings that match expected findings.",
  "aggregation.recall": "Expected findings present in final output.",
  "aggregation.f1": "Combined final-output precision and recall.",
  "aggregation.outcomeCorrect": "Expected case outcome produced.",
  "aggregation.statusCorrect": "Expected result status produced.",
  "reporting.requiredContent": "Required report sections rendered.",
  "reporting.coverageConsistent": "Coverage counts are internally consistent.",
  "reporting.provenanceComplete": "Required provenance metadata is present.",
};

function metricValue(metric: PipelineMetricSummary): string {
  if (metric.value === null || metric.value === undefined) return "N/A";
  if (metric.unit === "rate" || metric.unit === "boolean-rate") {
    const percentage = `${(metric.value * 100).toFixed(1)}%`;
    return metric.numerator !== undefined && metric.denominator !== undefined
      ? `${percentage} <small>(${metric.numerator}/${metric.denominator})</small>`
      : percentage;
  }
  if (metric.unit === "milliseconds") return `${(metric.value / 1000).toFixed(1)}s`;
  if (metric.unit === "tokens") return `${Math.round(metric.value).toLocaleString()} tokens`;
  return metric.aggregation === "mean" && metric.runs > 1
    ? `${metric.value.toFixed(2)} <small>/ run</small>`
    : metric.value.toFixed(2);
}

function metricCard(stage: PipelineStageSummary, metric: PipelineMetricSummary): string {
  const key = `${stage.id}.${metric.name}`;
  const meaning = meanings[key] ?? "Stage diagnostic metric.";
  const metricStatus = metric.value === null ? "na" : metric.direction === "lower" && metric.value > 0 ? "warn" : "ok";
  return `<article class="metric-card ${metricStatus}"><div class="metric-name">${esc(humanize(metric.name))}</div><div class="metric-value">${metricValue(metric)}</div><div class="metric-meaning">${esc(meaning)}</div></article>`;
}

function renderStage(stage: PipelineStageSummary): string {
  const state = displayStatus(stage.status);
  const primary = stage.metrics.filter((metric) => metric.primary);
  const diagnostics = stage.metrics.filter((metric) => !metric.primary);
  const blocked = stage.blockedBy.length ? `<p class="blocked-by">Blocked by: ${stage.blockedBy.map((item) => `<a href="#stage-${esc(item)}">${esc(item)}</a>`).join(", ")}</p>` : "";
  const stageDiagnostics = stage.diagnostics.length
    ? `<details class="diagnostics"><summary>Diagnostics (${stage.diagnostics.length})</summary><ul>${stage.diagnostics.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></details>`
    : "";
  const diagnosticOnly = stage.diagnosticOnly?.length
    ? `<details class="diagnostics"><summary>Diagnostic-only near misses (${stage.diagnosticOnly.length})</summary><ul>${stage.diagnosticOnly.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></details>`
    : "";
  const diagnosticMetrics = diagnostics.length
    ? `<details class="diagnostics"><summary>Diagnostic metrics (${diagnostics.length})</summary><div class="metric-grid">${diagnostics.map((metric) => metricCard(stage, metric)).join("")}</div></details>`
    : "";
  return `<article class="stage-card" id="stage-${esc(stage.id)}"><div class="stage-heading"><div><span class="stage-number">${esc(String(stage.id))}</span><h3>${esc(stage.name)}</h3></div><span class="state ${statusClass(state)}">${esc(state)}</span></div><p class="purpose">${esc(stage.purpose)}</p><div class="stage-counts"><span>${stage.evaluatedRuns}/${stage.applicableRuns ?? stage.runs} applicable runs evaluated</span><span>${stage.partialRuns} partial</span><span>${stage.blockedRuns} blocked</span><span>${stage.notEvaluableRuns} unable to evaluate</span><span>${stage.notApplicableRuns ?? 0} N/A</span></div>${blocked}<div class="metric-grid">${primary.length ? primary.map((metric) => metricCard(stage, metric)).join("") : `<p class="muted">No primary metrics were applicable.</p>`}</div>${diagnosticMetrics}${stageDiagnostics}${diagnosticOnly}</article>`;
}

function findMetric(value: unknown, name: string): PipelineMetricSummary | null {
  const metrics = (Array.isArray(dict(value).metrics) ? dict(value).metrics : []) as unknown[];
  const found = metrics.find((item: unknown) => dict(item).name === name) ??
    (metrics.length === 1 && dict(metrics[0]).value !== undefined ? metrics[0] : undefined);
  return found
    ? ({
        name,
        unit: "rate",
        aggregation: "ratio",
        runs: 1,
        primary: false,
        ...dict(found),
      } as unknown as PipelineMetricSummary)
    : null;
}

function renderRunSummary(run: Dict): string {
  const topline = dict(run.topline);
  const comparability = dict(run.comparability);
  const list = (value: unknown) => (Array.isArray(value) ? value : []).map((item) => String(item)).join(", ") || "none";
  const metrics: Array<[string, string, PipelineMetricSummary | null]> = [
    ["Selection recall", "Relevant findings whose scope was selected.", findMetric({ metrics: [topline.selectionRecall] }, "selectionRecall")],
    ["Candidate recall", "Expected findings found before verification.", findMetric({ metrics: [topline.candidateFindingRecall] }, "candidateFindingRecall")],
    ["Verified recall", "Expected findings published after verification.", findMetric({ metrics: [topline.verifiedFindingRecall] }, "verifiedFindingRecall")],
    ["Finding recall", "Expected findings present in final output.", findMetric({ metrics: [dict(topline.finding).recall] }, "findingRecall")],
    ["Finding precision", "Final findings that match the oracle.", findMetric({ metrics: [dict(topline.finding).precision] }, "findingPrecision")],
    ["Oracle resolution accuracy", "Candidate oracles reaching their required disposition.", findMetric({ metrics: [topline.oracleResolutionAccuracy] }, "oracleResolutionAccuracy")],
    ["Execution partial rate", "Runs where scheduled execution did not finish.", findMetric({ metrics: [dict(topline.reliability).executionPartialRate] }, "executionPartialRate")],
  ];
  return `<section id="summary"><h2>Evaluation summary</h2><p class="lede">The headline metrics below describe selection, detection, verification, and completeness. Stage details follow in pipeline order.</p><div class="summary-grid">${metrics.map(([title, meaning, metric]) => `<article class="summary-card"><div class="metric-name">${esc(title)}</div><div class="metric-value">${metric ? metricValue(metric) : "N/A"}</div><div class="metric-meaning">${esc(meaning)}</div></article>`).join("")}</div><div class="run-facts"><span>Eval status: <strong>${esc(displayStatus(run.evalStatus ?? run.status))}</strong></span><span>Execution status: <strong>${esc(displayStatus(run.executionStatus ?? dict(run.execution).status))}</strong></span><span>Cases: <strong>${esc(dict(run.corpus).activeCount ?? run.runs ?? "N/A")}</strong></span><span>Tokens: <strong>${esc(dict(topline.efficiency).totalTokens ?? "N/A")}</strong></span><span>Model calls: <strong>${esc(dict(topline.efficiency).modelCalls ?? "N/A")}</strong></span><span>Baseline eligible: <strong>${run.baselineEligible === true ? "yes" : run.baselineEligible === false ? "no" : "N/A"}</strong></span></div><div class="comparability"><strong>Evaluation schema:</strong> ${esc(run.evaluationSchemaVersion ?? "N/A")} · <strong>Metric definitions:</strong> ${esc(run.metricDefinitionVersion ?? "N/A")} · <strong>Baseline schema:</strong> ${esc(comparability.baselineSchemaVersion ?? "N/A")}<br><strong>Directly comparable:</strong> ${esc(list(comparability.directlyComparable))}<br><strong>New:</strong> ${esc(list(comparability.newMetrics))}<br><strong>Redefined:</strong> ${esc(list(comparability.redefinedMetrics))}<br><strong>Non-comparable:</strong> ${esc(list(comparability.nonComparableMetrics))}<br><strong>Baseline mode:</strong> ${esc(comparability.replacementMode ?? "N/A")}</div></section>`;
}

function renderCases(perCase: unknown[]): string {
  if (!perCase.length) return `<p class="muted">No case results supplied.</p>`;
  return `<table><thead><tr><th>Case</th><th>Eval status</th><th>Execution status</th><th>Candidate resolution</th><th>Oracle satisfied</th><th>Attribution</th><th>Candidate recall</th><th>Verified recall</th><th>Finding recall</th></tr></thead><tbody>${perCase.map((value) => {
    const item = dict(value);
    const topline = dict(item.liveTopline ?? item.topline);
    const finding = dict(topline.finding);
    const candidate = topline.candidateFindingRecall;
    const verified = topline.verifiedFindingRecall;
    const format = (metric: unknown) => metric ? metricValue({ ...(metric as PipelineMetricSummary), unit: "rate", aggregation: "ratio", runs: 1, primary: false }) : "N/A";
    const evalStatus = displayStatus(item.evalStatus ?? item.status);
    const executionStatus = displayStatus(item.executionStatus);
    const resolution = item.candidateResolution ? String(item.candidateResolution).toUpperCase() : "N/A";
    const oracleSatisfied = item.oracleSatisfied === true ? "yes" : item.oracleSatisfied === false ? "no" : "N/A";
    return `<tr><td>${esc(item.caseId)}</td><td><span class="state ${statusClass(evalStatus)}">${esc(evalStatus)}</span></td><td><span class="state ${statusClass(executionStatus)}">${esc(executionStatus)}</span></td><td>${esc(resolution)}</td><td>${esc(oracleSatisfied)}</td><td>${esc(item.reasonCode ?? "—")}</td><td>${format(candidate)}</td><td>${format(verified)}</td><td>${format(finding.recall)}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function renderComparison(value: unknown): string {
  const topline = dict(dict(value).topline);
  const rows = Object.entries(topline);
  if (!rows.length) return "";
  return `<section id="comparison"><h2>Comparison</h2><table><thead><tr><th>Metric</th><th>Baseline</th><th>Current</th><th>Delta</th></tr></thead><tbody>${rows.map(([name, metric]) => {
    const item = dict(metric);
    const display = (entry: unknown) => typeof entry === "number" ? entry.toFixed(4) : "N/A";
    return `<tr><td>${esc(humanize(name))}</td><td>${esc(display(item.baseline))}</td><td>${esc(display(item.current))}</td><td>${esc(display(item.delta))}</td></tr>`;
  }).join("")}</tbody></table></section>`;
}

export function renderEvalHtml(input: EvalHtmlInput): string {
  const run = input.run ?? input;
  const report = dict(run);
  const suite = input.suite ?? report.suite ?? report.suites;
  const modelTarget = report.modelTarget ?? dict(report.configuration).modelTarget;
  const pipeline = dict(report.pipeline);
  const stages = (Array.isArray(pipeline.stages) ? pipeline.stages : []) as PipelineStageSummary[];
  const perCase = Array.isArray(report.perCase) ? report.perCase : [];
  const comparison = input.comparison ?? report.comparison ?? report.comparisons;
  const comparisonSection = renderComparison(comparison);
  const navItems = [["summary", "Summary"], ["pipeline", "Pipeline"], ["cases", "Cases"]];
  if (comparisonSection) navItems.push(["comparison", "Comparison"]);
  const nav = navItems.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("");
  const stageFlow = stages.length
    ? `<div class="stage-flow">${stages.map((stage, index) => `<a href="#stage-${esc(stage.id)}" class="flow-item"><span>${index + 1}</span>${esc(stage.name)}</a>`).join("")}</div>`
    : `<p class="muted">This report predates the structured pipeline summary.</p>`;
  const pipelineSection = `<section id="pipeline"><h2>Pipeline stages</h2><p class="lede">Each card is one evaluator component. Metrics show the component contract, not a generic aggregate score.</p>${stageFlow}<div class="stage-list">${stages.map(renderStage).join("")}</div></section>`;
  const reportStatus = displayStatus(report.evalStatus ?? report.status ?? report.outcome);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentSmith Evaluation Report</title><style>
body{font:14px system-ui,-apple-system,sans-serif;margin:0;background:#f5f7fb;color:#20242a}nav{position:sticky;top:0;z-index:2;background:#17202a;padding:12px 20px;display:flex;gap:18px;flex-wrap:wrap}nav a{color:#fff;text-decoration:none}main{max-width:1240px;margin:auto;padding:20px}section{background:#fff;border:1px solid #d9e0e8;border-radius:10px;margin:16px 0;padding:20px}h1{margin:0 0 8px}h2{margin:0 0 12px}h3{margin:0;font-size:18px}.lede,.purpose{color:#526273;max-width:900px}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px}.summary-card,.metric-card{border:1px solid #d9e0e8;border-radius:8px;padding:12px;background:#fbfcfe}.summary-card{border-top:4px solid #3678c7}.metric-card.ok{border-left:4px solid #2f8f55}.metric-card.warn{border-left:4px solid #c58a16}.metric-card.na{border-left:4px solid #8793a1}.metric-name{font-weight:650;color:#425466}.metric-value{font-size:24px;font-weight:750;margin:5px 0}.metric-value small{font-size:13px;font-weight:500}.metric-meaning{font-size:12px;color:#687585;line-height:1.35}.run-facts,.stage-counts{display:flex;gap:16px;flex-wrap:wrap;color:#526273;margin-top:18px}.comparability{margin-top:18px;padding:12px;background:#f3f7fb;border-left:4px solid #3678c7;color:#526273;line-height:1.6}.stage-flow{display:flex;gap:4px;flex-wrap:wrap;margin:18px 0 24px}.flow-item{display:flex;align-items:center;gap:7px;background:#edf3fa;border:1px solid #cbd9e8;color:#234d75;text-decoration:none;padding:8px 10px;border-radius:7px}.flow-item span,.stage-number{font-size:11px;text-transform:uppercase;color:#687585}.stage-card{border:1px solid #d9e0e8;border-radius:10px;padding:18px;margin:14px 0}.stage-heading{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.stage-heading>div{display:flex;gap:10px;align-items:baseline}.stage-counts{font-size:12px;margin:10px 0}.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}.state{font-weight:750;padding:4px 8px;border-radius:5px;white-space:nowrap}.pass{color:#176b35;background:#d9f4e2}.fail,.error{color:#9c1c1c;background:#ffe0e0}.partial,.incomplete{color:#855b00;background:#fff0c2}.blocked,.not-evaluable{color:#6c4b00;background:#f8e8b0}.na{color:#526273;background:#edf0f3}.blocked-by{background:#fff7df;border:1px solid #ead69a;padding:9px;border-radius:6px}.diagnostics{margin-top:14px;border-top:1px solid #e0e5eb;padding-top:10px}.diagnostics summary{cursor:pointer;color:#234d75;font-weight:650}.diagnostics ul{margin-bottom:0}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border:1px solid #e0e5eb;padding:7px;text-align:left;vertical-align:top}th{background:#f0f3f7}.muted{color:#687585}
</style></head><body><nav>${nav}</nav><main><h1>AgentSmith Evaluation Report <span class="state ${statusClass(reportStatus)}">${esc(reportStatus)}</span></h1><p>Suite: <strong>${esc(suite)}</strong> · Model target: <strong>${esc(modelTarget)}</strong></p>${renderRunSummary(report)}${pipelineSection}<section id="cases"><h2>Cases</h2>${renderCases(perCase)}</section>${comparisonSection}</main></body></html>`;
}
