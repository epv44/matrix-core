import fs from "node:fs";
import path from "node:path";
import { runGate } from "../core/gate.js";
import { runQualityCompletion, runQualityReview } from "../core/review.js";
import { prepareFix } from "../core/fix.js";
import { getQualityStatus } from "../core/status.js";
import { resolveConfig } from "../core/config-resolver.js";
import { recordEngineRuntime } from "../core/runtime.js";
import { repositoryGraph } from "../core/graph/index.js";

export type QualityToolName = "quality_run" | "quality_status" | "quality_fix" | "graph_status";

export interface QualityToolInput {
  root?: string;
  mode?: "changed" | "full" | "review" | "completion";
  fast?: boolean;
  base?: string;
  review_version?: string;
  finding_ids?: string[];
}

export function resolveToolRoot(inputRoot?: string): string {
  const candidate = path.resolve(
    inputRoot ?? process.env.MATRIXCORE_WORKSPACE_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  );
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory())
    throw new Error(`Workspace root is not a directory: ${candidate}`);
  return resolveConfig({ cwd: fs.realpathSync(candidate) }).configRoot;
}

export async function executeQualityTool(
  name: QualityToolName,
  input: QualityToolInput,
  signal?: AbortSignal,
): Promise<unknown> {
  const root = resolveToolRoot(input.root);
  recordEngineRuntime(root, "mcp");
  if (signal?.aborted) throw signal.reason ?? new Error("MatrixCore operation cancelled");
  if (name === "graph_status") return repositoryGraph(root).ensureReady();
  if (name === "quality_status") return getQualityStatus(root);
  if (name === "quality_fix")
    return prepareFix({
      cwd: root,
      reviewVersion: input.review_version ?? "",
      findingIds: input.finding_ids ?? [],
    });
  const mode = input.mode ?? "full";
  if (mode === "completion")
    return runQualityCompletion({
      cwd: root,
      mode: "full",
      fast: false,
      base: input.base,
      tool: "quality_run",
      adapter: "mcp",
      signal,
    });
  if (mode === "review")
    return runQualityReview({
      cwd: root,
      mode: "full",
      fast: input.fast,
      base: input.base,
      tool: "quality_run",
      adapter: "mcp",
      signal,
    });
  return runGate({
    cwd: root,
    mode,
    fast: input.fast,
    base: input.base,
    tool: "quality_run",
    adapter: "mcp",
    signal,
  });
}
