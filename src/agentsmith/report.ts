import type { GateStatus, ReviewFinding, ReviewResult } from "../core/types.js";

export const REVIEW_MARKDOWN_ARTIFACT = ".quality/review-result.md";
function cell(value: unknown) {
  return (
    String(value ?? "—")
      .replace(/\r?\n/g, " ")
      .replace(/\|/g, "\\|")
      .trim() || "—"
  );
}
function table(headers: string[], rows: unknown[][]) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}
function location(finding: ReviewFinding) {
  return `${finding.file}:${finding.line}${finding.endLine && finding.endLine !== finding.line ? `-${finding.endLine}` : ""}`;
}

export function formatAgentSmithReview(
  review: ReviewResult | null,
  options: { gateStatus?: GateStatus; artifact?: string | null } = {},
) {
  const lines = ["## AgentSmith Review", ""];
  if (!review) {
    lines.push("**Outcome:** Review disabled.");
    if (options.gateStatus) lines.push(`**Deterministic gate:** ${options.gateStatus}.`);
    return lines.join("\n");
  }
  const outcome =
    review.outcome === "findings"
      ? `${review.findings.length} verified finding${review.findings.length === 1 ? "" : "s"} pending human triage (advisory${review.coverage.selection === "bounded" ? "; selected risk-ranked scope" : ""})`
      : review.outcome === "incomplete"
        ? review.coverage.timeout
          ? "Review incomplete; partial review due to timeout. Do not interpret an empty finding list as approval"
          : review.errors?.length
            ? "Review incomplete; partial review due to provider failure. Do not interpret an empty finding list as approval"
            : "Review incomplete; do not interpret an empty finding list as approval"
        : review.coverage.selection === "bounded"
          ? "Bounded risk-ranked review completed; do not interpret an empty finding list as global approval"
          : "No verified findings";
  lines.push(`**Outcome:** ${outcome}.`);
  if (options.gateStatus) lines.push(`**Deterministic gate:** ${options.gateStatus}.`);
  lines.push(`**Review status:** ${review.status}.`);
  lines.push(`**Candidate mode:** ${review.mode}.`);
  if (review.coverage.selection) lines.push(`**Selection:** ${review.coverage.selection}.`);
  if (review.coverage.timeout)
    lines.push(
      `**Deadline:** ${review.coverage.timeout.deadlineMs}ms; elapsed ${review.coverage.timeout.elapsedMs}ms; calls ${review.coverage.timeout.callsStarted} started, ${review.coverage.timeout.callsCompleted} completed, ${review.coverage.timeout.callsCancelled} cancelled.`,
    );
  if (review.profileHash) lines.push(`**Profile hash:** \`${review.profileHash}\`.`);
  lines.push(`**Review version:** \`${review.version}\`.`);
  if (options.artifact) lines.push(`**Artifact:** \`${options.artifact}\`.`);

  lines.push("", "### Coverage", "");
  lines.push(
    table(
      ["Surface", "Reviewed", "Eligible/total"],
      [
        ["Changed files", review.coverage.changedFilesReviewed, review.coverage.changedFiles],
        ["Changed symbols", review.coverage.changedSymbolsReviewed, review.coverage.changedSymbols],
        ["Local units", review.coverage.localUnitsReviewed, review.coverage.localUnitsGenerated],
        ["Interaction units", review.coverage.interactionUnitsReviewed, review.coverage.interactionUnitsGenerated],
        [
          "Dependency edges",
          review.coverage.dependencyEdgesReviewed,
          `${review.coverage.dependencyEdgesEligible}/${review.coverage.dependencyEdgesIdentified} eligible/identified`,
        ],
        [
          "Evidence",
          review.coverage.evidenceResolved,
          `${review.coverage.evidenceRequests} requests; ${review.coverage.evidenceGaps} gaps`,
        ],
        ["Global scan", review.coverage.globalScan, "—"],
      ],
    ),
  );
  if (review.coverage.globalScan) {
    const bounds = [
      ["Configured parallelism", review.coverage.configuredParallelism ?? "—"],
      ["Effective parallelism", review.coverage.effectiveParallelism ?? "—"],
      ["Max in-flight calls", review.coverage.maxObservedConcurrency ?? "—"],
      ["Deadline", review.coverage.deadlineMs ? `${review.coverage.deadlineMs}ms` : "—"],
      ["Elapsed", review.coverage.elapsedMs ? `${review.coverage.elapsedMs}ms` : "—"],
    ];
    const tokens = [
      ["Candidate budget", review.coverage.candidateTokenBudget ?? "—"],
      ["Candidate est. usage", review.coverage.candidateTokensEstimated ?? "—"],
      ["Verification budget", review.coverage.verificationTokenBudget ?? "—"],
      ["Verification est. usage", review.coverage.verificationTokensEstimated ?? "—"],
    ];
    const accounting = [
      ["Calls started", review.coverage.callsStarted ?? "—"],
      ["Calls completed", review.coverage.callsCompleted ?? "—"],
      ["Calls cancelled", review.coverage.callsCancelled ?? "—"],
      ["Work items selected", review.coverage.selectedWorkItems ?? "—"],
      ["Work items omitted", review.coverage.omittedWorkItems ?? "—"],
      ["Token-budget omissions", review.coverage.tokenBudgetOmissions ?? "—"],
      ["Timeout omissions", review.coverage.timeoutOmissions ?? "—"],
    ];
    lines.push("", "### Execution bounds", "");
    lines.push(table(["Metric", "Value"], bounds));
    lines.push(table(["Metric", "Value"], tokens));
    lines.push(table(["Metric", "Value"], accounting));
  }
  if (review.findings.length) {
    lines.push("", "### Verified findings", "");
    lines.push(
      table(
        ["ID", "Severity", "Category", "Location", "Finding", "Evidence", "Suggestion"],
        review.findings.map((finding) => [
          finding.id,
          finding.severity,
          finding.category,
          location(finding),
          `${finding.title}: ${finding.description}`,
          finding.evidence.map((evidence) => `${evidence.file}:${evidence.startLine}-${evidence.endLine}`).join(", "),
          finding.suggestion,
        ]),
      ),
    );
  }
  if (review.candidates) {
    lines.push("", "### Candidate verification", "");
    lines.push(
      table(
        ["Generated", "Verified", "Likely (not published)", "Rejected", "Insufficient evidence"],
        [
          [
            review.candidates.generated,
            review.candidates.verified,
            review.candidates.likely,
            review.candidates.rejected,
            review.candidates.insufficientEvidence,
          ],
        ],
      ),
    );
  }
  if (review.coverage.omissions.length) {
    lines.push("", "### Omissions", "");
    lines.push(
      table(
        ["Kind", "Item", "Reason"],
        review.coverage.omissions.map((item) => [item.kind, item.id, item.reason]),
      ),
    );
  }
  if (review.errors?.length) {
    lines.push("", "### Review errors", "");
    lines.push(
      table(
        ["Error"],
        review.errors.map((error) => [error]),
      ),
    );
  }
  if (review.findings.length)
    lines.push(
      "",
      "AgentSmith is advisory. Select verified finding IDs explicitly before running `quality_fix`; MatrixCore does not apply fixes automatically.",
    );
  return lines.join("\n");
}
