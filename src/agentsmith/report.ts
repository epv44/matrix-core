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

const incompleteReasonLabels: Record<NonNullable<ReviewResult["incompleteReasons"]>[number]["kind"], string> = {
  "stale-workspace": "Workspace changed during review",
  "provider-failure": "Review provider failed",
  timeout: "Review deadline reached",
  "evidence-packing-budget": "Required verifier evidence could not fit in the evidence budget",
  "citation-validation-failure": "Verifier citations remained invalid after repair",
  "unfinished-work-item": "Selected review work did not complete",
  "insufficient-context": "Candidate task reported insufficient context",
  "unadjudicated-candidate": "Candidate verification did not complete",
  "insufficient-evidence": "Candidates lacked sufficient evidence",
  "likely-unpublished": "Likely findings could not be verified",
  "material-omission": "Material review scope was omitted",
};

const omissionReasonLabels: Record<string, string> = {
  binary: "Binary files excluded",
  generated: "Generated files excluded",
  "unsafe-large-file": "Files exceeded the safe review size",
  "lower-ranked": "Outside the selected risk-ranked scope",
  "token-budget": "Outside the review token budget",
  timeout: "Review deadline reached",
};

function coverageLimitations(review: ReviewResult): Array<[string, number]> {
  const counts = new Map<string, number>();
  const detailedIds = new Set(review.incompleteReasons?.flatMap((reason) => (reason.id ? [reason.id] : [])) ?? []);
  const add = (label: string) => counts.set(label, (counts.get(label) ?? 0) + 1);

  for (const reason of review.incompleteReasons ?? []) add(incompleteReasonLabels[reason.kind]);
  for (const omission of review.coverage.omissions) {
    if (detailedIds.has(omission.id)) continue;
    add(omissionReasonLabels[omission.reason] ?? "Other review scope omissions");
  }
  if (review.errors?.length && !review.incompleteReasons?.some((reason) => reason.kind === "provider-failure"))
    for (const _error of review.errors) add("Review infrastructure errors");

  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
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
        ? review.status === "completed"
          ? "Review execution completed, but one or more candidates remain unresolved. Do not interpret an empty finding list as approval"
          : review.coverage.timeout
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
  lines.push(`**Review path:** ${review.reviewPath}.`);
  lines.push(`**Candidate mode:** ${review.mode}.`);
  if (review.coverage.selection) lines.push(`**Selection:** ${review.coverage.selection}.`);
  if (options.artifact) lines.push(`**Artifact:** \`${options.artifact}\`.`);

  lines.push("", "### AgentSmith Summary", "", review.summary || "No summary available.");

  if (review.reviewPath === "specialist" && review.specialists?.length) {
    const labels = {
      "architecture-reviewer": "Architecture Reviewer",
      "perf-reviewer": "Performance Reviewer",
      "bug-hunter": "Correctness Reviewer",
      "semantic-reviewer": "Semantic Reviewer",
    } as const;
    lines.push("", "### Specialist Reviews");
    for (const specialist of review.specialists) {
      lines.push(
        "",
        `#### ${labels[specialist.reviewer]}`,
        "",
        `**Status:** ${specialist.status}.`,
        "",
        "##### Summary",
        "",
        specialist.summary || "No summary available.",
        "",
        "##### Candidate Outcomes",
        "",
      );
      if (specialist.candidates.length)
        lines.push(
          table(
            ["ID", "Severity", "Location", "Candidate", "Disposition", "Reason"],
            specialist.candidates.map((candidate) => [
              candidate.id,
              candidate.severity,
              `${candidate.file}:${candidate.line}`,
              candidate.title,
              candidate.disposition.replaceAll("_", " "),
              candidate.reasoning ?? "—",
            ]),
          ),
        );
      else lines.push("No candidates reported.");
    }
  }

  lines.push("", "### Verified Findings", "");
  if (review.findings.length) {
    lines.push(
      table(
        ["ID", "Severity", "Category", "Location", "Finding", "Evidence", "Suggestion", "Reported by"],
        review.findings.map((finding) => [
          finding.id,
          finding.severity,
          finding.category,
          location(finding),
          `${finding.title}: ${finding.description}`,
          finding.evidence.map((evidence) => `${evidence.file}:${evidence.startLine}-${evidence.endLine}`).join(", "),
          finding.suggestion,
          finding.sourceReviewers?.length ? finding.sourceReviewers.join(", ") : "generic engine",
        ]),
      ),
    );
  } else lines.push("No verified findings.");

  lines.push("", "### Candidate Verification", "");
  if (review.candidates) {
    lines.push(
      table(
        [
          "Generated",
          "Shortlisted",
          "Adjudicated",
          "Omitted",
          "Verified",
          "Likely",
          "Rejected",
          "Insufficient evidence",
        ],
        [
          [
            review.candidates.generated,
            review.candidates.shortlisted ?? "—",
            review.candidates.adjudicated ?? "—",
            review.candidates.omitted ?? "—",
            review.candidates.verified,
            review.candidates.likely,
            review.candidates.rejected,
            review.candidates.insufficientEvidence,
          ],
        ],
      ),
    );
  } else lines.push("No candidates generated.");

  const candidateResolutions = review.candidateResolutions ?? [];
  if (candidateResolutions.length) {
    lines.push(
      "",
      "### Candidate Resolution Audit",
      "",
      table(
        ["Candidate", "Resolution", "Attribution", "Verifier disposition", "Detail"],
        candidateResolutions.map((candidate) => [
          candidate.candidateId,
          candidate.resolution,
          candidate.reasonCode ?? "—",
          candidate.verifier?.verdict ?? "not run",
          candidate.detail,
        ]),
      ),
    );
  }

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
          `${review.coverage.evidenceRequestsSatisfied ?? review.coverage.evidenceResolved}/${review.coverage.evidenceRequests} requests satisfied`,
          `${review.coverage.evidenceRequestsPartiallySatisfied ?? 0} partial; ${review.coverage.evidenceRequestsUnresolved ?? review.coverage.evidenceGaps} unresolved; ${review.coverage.evidenceRequestsSkipped ?? 0} skipped; ${review.coverage.evidenceRecordsPacked ?? review.coverage.evidenceResolved} records packed`,
        ],
        ["Global scan", review.coverage.globalScan, "—"],
      ],
    ),
  );
  const limitations = coverageLimitations(review);
  if (limitations.length) {
    lines.push("", "### Coverage Limitations", "");
    lines.push(table(["Reason", "Count"], limitations));
  }
  if (review.errors?.length) {
    lines.push("", "### Review Errors", "");
    lines.push(table(["Error", "Count"], [["Review infrastructure or provider failure", review.errors.length]]));
  }
  if (review.findings.length)
    lines.push(
      "",
      "AgentSmith is advisory. Select verified finding IDs explicitly before running `quality_fix`; MatrixCore does not apply fixes automatically.",
    );
  return lines.join("\n");
}
