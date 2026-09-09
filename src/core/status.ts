import { resolveConfig } from "./config-resolver.js";
import { readGateResult, readLegacyGateResult } from "./gate-store.js";
import { gateMatchesIdentity } from "./gate.js";
import { computeWorkspaceVersion } from "./version.js";
import { readReviewResult } from "../agentsmith/review-store.js";
import type {
  CompletionIdentityDiagnostics,
  CompletionIdentitySnapshot,
  GateResult,
  QualityStatus,
  ResolvedPolicy,
} from "./types.js";
import { resolveWorkspaceSet } from "./workspace.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { toolVersion } from "./runner.js";
import { formatAgentSmithReview, REVIEW_MARKDOWN_ARTIFACT } from "../agentsmith/report.js";
import type { GateStatus, ReviewResult } from "./types.js";
import { engineRuntimeIdentity } from "./runtime.js";
import { isReviewApproval } from "./reviewer.js";

function reviewPresentation(review: ReviewResult | null, gateStatus?: GateStatus) {
  return {
    reviewMarkdown: review ? formatAgentSmithReview(review, { gateStatus, artifact: REVIEW_MARKDOWN_ARTIFACT }) : null,
    reviewArtifact: review ? REVIEW_MARKDOWN_ARTIFACT : null,
  };
}

export function currentToolVersions(
  workspaces: ReturnType<typeof resolveWorkspaceSet>["workspaces"],
  policy: ResolvedPolicy,
) {
  return Object.fromEntries(
    workspaces
      .flatMap((workspace) => [
        ...policy.checks
          .filter((check) => check.language === workspace.language)
          .map((check) => {
            const binary = workspace.toolEnvironment.binaries[check.tool];
            return [`${workspace.id}:${check.tool}`, binary ? toolVersion(binary) : null] as const;
          }),
        ...workspace.sqlFacets.flatMap((facet) =>
          policy.checks
            .filter((check) => check.language === "sql")
            .map((check) => {
              const binary = facet.toolEnvironment.binaries[check.tool];
              return [`${facet.id}:${check.tool}`, binary ? toolVersion(binary) : null] as const;
            }),
        ),
      ])
      .filter((entry) => entry[1] !== null)
      .map(([name, version]) => [name, version!] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function recordedIdentity(gate: GateResult): CompletionIdentitySnapshot {
  return {
    workspaceVersion: gate.version,
    workspaceHash: gate.workspaceHash,
    policyHash: gate.policy?.policyHash ?? null,
    toolVersions: gate.toolVersions ?? {},
    engineVersion: gate.createdBy?.engineVersion ?? null,
    enginePath: gate.createdBy?.enginePath ?? null,
    enginePackageRoot: gate.createdBy?.enginePackageRoot ?? null,
  };
}

export function compareCompletionIdentity(
  gate: GateResult | null,
  current: CompletionIdentitySnapshot,
): CompletionIdentityDiagnostics {
  if (!gate) return { current, recorded: null, mismatches: ["gateEvidence"] };
  const recorded = recordedIdentity(gate);
  const mismatches: string[] = [];
  if (recorded.workspaceVersion !== current.workspaceVersion) mismatches.push("workspaceVersion");
  if (recorded.workspaceHash !== current.workspaceHash) mismatches.push("workspaceHash");
  if (recorded.policyHash !== current.policyHash) mismatches.push("policyHash");
  for (const name of [...new Set([...Object.keys(recorded.toolVersions), ...Object.keys(current.toolVersions)])].sort())
    if (recorded.toolVersions[name] !== current.toolVersions[name]) mismatches.push(`toolVersion:${name}`);
  if (recorded.engineVersion && recorded.engineVersion !== current.engineVersion) mismatches.push("engineVersion");
  if (recorded.enginePackageRoot && recorded.enginePackageRoot !== current.enginePackageRoot)
    mismatches.push("enginePackageRoot");
  return { current, recorded, mismatches };
}

function mismatchReason(identity: CompletionIdentityDiagnostics): string {
  const recorded = identity.recorded!;
  const details = identity.mismatches.map((dimension) => {
    if (dimension.startsWith("toolVersion:")) {
      const tool = dimension.slice("toolVersion:".length);
      return `${dimension} (recorded=${recorded.toolVersions[tool] ?? "missing"}, current=${identity.current.toolVersions[tool] ?? "missing"})`;
    }
    const key = dimension as Exclude<keyof CompletionIdentitySnapshot, "toolVersions">;
    return `${dimension} (recorded=${recorded[key] ?? "missing"}, current=${identity.current[key] ?? "missing"})`;
  });
  const runtimeContext = identity.mismatches.some((dimension) =>
    ["engineVersion", "enginePackageRoot"].includes(dimension),
  )
    ? `; producer=${recorded.engineVersion ?? "unknown"}@${recorded.enginePath ?? recorded.enginePackageRoot ?? "unknown"}; hook=${identity.current.engineVersion ?? "unknown"}@${identity.current.enginePath ?? identity.current.enginePackageRoot ?? "unknown"}`
    : "";
  return `Completion evidence is stale: ${details.join("; ")}${runtimeContext}. Run quality_run with mode=completion.`;
}

export function getQualityStatus(cwd: string): QualityStatus {
  const resolved = resolveConfig({ cwd });
  const runtime = engineRuntimeIdentity();
  if (resolved.isDefault) {
    return {
      schemaVersion: 1,
      configured: false,
      root: resolved.configRoot,
      version: null,
      gate: null,
      review: null,
      ...reviewPresentation(null),
      completionAllowed: true,
      runtime,
      reason: "MatrixCore is not configured for this workspace",
    };
  }

  const root = resolved.configRoot;
  let policy: ResolvedPolicy;
  try {
    policy = resolvePolicyForConfig(resolved);
  } catch (error) {
    const version = computeWorkspaceVersion(root);
    const review = readReviewResult(root);
    return {
      schemaVersion: 1,
      configured: true,
      root,
      version,
      gate: readGateResult(root, "full"),
      changedGate: readGateResult(root, "changed"),
      review,
      ...reviewPresentation(review),
      reviewRequired: resolved.config.review?.agentsmith ?? false,
      completionAllowed: false,
      reason: `MatrixCore policy unavailable: ${error instanceof Error ? error.message : String(error)}`,
      runtime,
    };
  }
  const workspaceSet = resolveWorkspaceSet(root, resolved.config.application);
  const workspaces = workspaceSet.workspaces;
  const version = computeWorkspaceVersion(root);
  const gate = readGateResult(root, "full");
  const changedGate = readGateResult(root, "changed");
  const review = readReviewResult(root);
  const reviewRequired = resolved.config.agentsmith?.enabled === true;
  const reviewAdvisory = resolved.config.agentsmith?.advisory !== false;
  const reviewBlocksCompletion = reviewRequired && !reviewAdvisory;
  const currentIdentity: CompletionIdentitySnapshot = {
    workspaceVersion: version,
    workspaceHash: workspaceSet.workspaceHash,
    policyHash: policy.policyHash,
    toolVersions: currentToolVersions(workspaces, policy),
    engineVersion: runtime.version,
    enginePath: runtime.executablePath,
    enginePackageRoot: runtime.packageRoot,
  };
  const identity = compareCompletionIdentity(gate, currentIdentity);
  const statusBase = {
    schemaVersion: 1 as const,
    configured: true as const,
    root,
    version,
    gate,
    changedGate,
    review,
    ...reviewPresentation(review, gate?.status),
    reviewRequired,
    workspaces,
    workspaceHash: workspaceSet.workspaceHash,
    policy,
    runtime,
    identity,
  };
  const blocked = (reason: string, overrides: Record<string, unknown> = {}): QualityStatus => ({
    ...statusBase,
    ...overrides,
    completionAllowed: false,
    reason,
  });
  if (!gate)
    return blocked(
      readLegacyGateResult(root)
        ? "Legacy gate evidence has no execution scope and cannot authorize completion. Run quality_run with mode=completion."
        : "Quality gate has not been run. Run quality_run with mode=completion before finishing.",
      { reviewEnabled: reviewRequired, reviewAdvisory },
    );
  if (gate.status !== "PASS")
    return blocked(
      `Quality gate is ${gate.status}. Fix deterministic failures and run quality_run with mode=completion.`,
    );
  if (gate.schemaVersion !== 2 || gate.mode !== "full" || gate.fast)
    return blocked("Completion requires a full, non-fast deterministic gate. Run quality_run with mode=completion.");
  if (
    !gateMatchesIdentity(gate, { version, workspaceHash: workspaceSet.workspaceHash, policyHash: policy.policyHash }) ||
    identity.mismatches.length > 0
  )
    return blocked(mismatchReason(identity));
  if (
    reviewBlocksCompletion &&
    (!review ||
      review.version !== version ||
      review.profileHash !== policy.agentSmith.hash ||
      review.status === "stale")
  )
    return blocked("AgentSmith review is missing or stale. Run quality_run with mode=completion before finishing.", {
      reviewEnabled: reviewRequired,
      reviewAdvisory,
    });
  if (reviewBlocksCompletion && (!review || !isReviewApproval(review)))
    return blocked(
      "AgentSmith review did not produce a completed clear result with every candidate resolved. Resolve findings, unresolved candidates, or execution errors and run quality_run with mode=completion.",
      { reviewEnabled: reviewRequired, reviewAdvisory },
    );
  return {
    ...statusBase,
    reviewEnabled: reviewRequired,
    reviewAdvisory,
    completionAllowed: true,
  };
}

export function evaluateCompletion(cwd: string): QualityStatus {
  try {
    return getQualityStatus(cwd);
  } catch (error) {
    return {
      schemaVersion: 1,
      configured: true,
      root: cwd,
      version: null,
      gate: null,
      review: null,
      ...reviewPresentation(null),
      completionAllowed: false,
      runtime: engineRuntimeIdentity(),
      reason: `MatrixCore completion check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
