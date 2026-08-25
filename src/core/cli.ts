#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import yaml from "js-yaml";
import { runDoctor, doctorToJson, doctorToReport } from "./doctor.js";
import { resolveConfig } from "./config-resolver.js";
import { formatVerificationSection } from "./report.js";
import { runQualityReview } from "./review.js";
import { runQualityCompletion } from "./review.js";
import { prepareFix } from "./fix.js";
import { getQualityStatus } from "./status.js";
import { ENGINE_VERSION } from "./meta.js";
import { resolvePolicyForConfig } from "./resolved-policy.js";
import { githubPolicyStatus, syncGitHubPolicy } from "./github-policy.js";
import { runGate } from "./gate.js";
import { resolveWorkspaceSet } from "./workspace.js";
import { repositoryGraph } from "./graph/index.js";
import { listAgentSmithTraces, readAgentSmithTrace, traceStatus } from "../agentsmith/trace.js";
const program = new Command();
program.name("quality").description("Standalone Quality Engine").version(ENGINE_VERSION);
const workspaceCommand = program.command("workspace").description("Inspect resolved language workspaces");
workspaceCommand
  .command("show")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .action((opts) => {
    const resolved = resolveConfig({ cwd: opts.root });
    const workspaceSet = resolveWorkspaceSet(resolved.configRoot, resolved.config.application);
    console.log(
      opts.json
        ? JSON.stringify({ root: resolved.configRoot, ...workspaceSet }, null, 2)
        : yaml.dump(workspaceSet, { noRefs: true }),
    );
  });
const policyCommand = program.command("policy").description("Inspect the immutable MatrixCore policy");
policyCommand
  .command("show")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .action((opts) => {
    const resolved = resolveConfig({ cwd: opts.root });
    const policy = resolvePolicyForConfig(resolved);
    console.log(opts.json ? JSON.stringify(policy, null, 2) : yaml.dump(policy, { noRefs: true }));
  });
policyCommand
  .command("status")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .action((opts) => {
    const resolved = resolveConfig({ cwd: opts.root });
    const source = resolved.config.policySource;
    const status = source
      ? githubPolicyStatus(resolved.configRoot, source)
      : { configured: false, provider: "embedded", networkUsed: false };
    console.log(opts.json ? JSON.stringify(status, null, 2) : yaml.dump(status, { noRefs: true }));
    process.exitCode = !source || ("valid" in status && status.valid) ? 0 : 1;
  });
policyCommand
  .command("sync")
  .option("--root <path>", "Project root", process.cwd())
  .option("--locked", "Restore the exact committed lock without advancing its ref", false)
  .option("--json", "JSON output", false)
  .action(async (opts) => {
    const resolved = resolveConfig({ cwd: opts.root });
    const source = resolved.config.policySource;
    if (!source) throw new Error("quality.yaml does not declare a GitHub policy source");
    const result = await syncGitHubPolicy({ root: resolved.configRoot, source, locked: opts.locked });
    const output = {
      repository: source.repository,
      configuredRef: source.ref,
      resolvedCommit: result.lock.resolvedCommit,
      policyHash: result.lock.policyHash,
      cacheHit: result.cacheHit,
      lockUpdated: !opts.locked,
      changes: result.changes,
    };
    console.log(opts.json ? JSON.stringify(output, null, 2) : yaml.dump(output, { noRefs: true }));
  });
const graphCommand = program.command("graph").description("Inspect and build the persistent repository graph");
const renderGraph = async (opts: { root: string; json: boolean }) => {
  const status = await repositoryGraph(opts.root).ensureReady();
  console.log(opts.json ? JSON.stringify(status, null, 2) : yaml.dump(status, { noRefs: true }));
};
graphCommand
  .command("status")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .action(renderGraph);
graphCommand
  .command("index")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .action(renderGraph);
program
  .command("run")
  .description("Run the centrally owned deterministic MatrixCore gate")
  .option("-c, --config <path>", "Path to quality.yaml")
  .option("--changed", "Run only on changed files (git diff)", false)
  .option("--full", "Run full checks (default)", false)
  .option("--fast", "Use changed-workspace execution optimizations", false)
  .option("--base <branch>", "Base branch for --changed")
  .option("--root <path>", "Project root", process.cwd())
  .option("--file <path>", "Single changed file (implies changed mode)", undefined)
  .option("--json", "JSON output", false)
  .option("--markdown", "Markdown verification block", false)
  .action(async (opts) => {
    try {
      const isChanged = (opts.changed || !!opts.file) && !opts.full;
      const changedFiles = opts.file ? [path.resolve(opts.root, opts.file)] : undefined;
      const result = await runGate({
        cwd: opts.root,
        configFlag: opts.config,
        mode: isChanged ? "changed" : "full",
        base: opts.base,
        fast: opts.fast,
        changedFiles,
        tool: "matrix-core run",
        adapter: "cli",
      });
      if (opts.markdown)
        console.log(
          formatVerificationSection({
            status: result.status,
            version: result.version,
            mode: isChanged ? "changed" : "full",
            timestamp: result.timestamp,
            results: result.checks,
            failures: result.failures,
            metrics: result.metrics,
          }),
        );
      else if (opts.json) console.log(JSON.stringify(result, null, 2));
      else
        console.log(
          [
            `MatrixCore deterministic gate: ${result.status}`,
            `Workspace hash: ${result.workspaceHash}`,
            `Policy hash: ${result.policy?.policyHash}`,
            ...result.checks.map(
              (check) => `- ${check.plugin}: ${check.status}${check.reason ? ` (${check.reason})` : ""}`,
            ),
            ...result.failures.map((failure) => `- failure: ${failure}`),
          ].join("\n"),
        );
      process.exit(result.status === "PASS" ? 0 : 1);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(2);
    }
  });
program
  .command("status")
  .description("Read the current gate, review, and completion decision without running checks")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .action((opts) => {
    try {
      const status = getQualityStatus(opts.root);
      console.log(
        opts.json
          ? JSON.stringify(status, null, 2)
          : status.configured
            ? [
                `MatrixCore completion ${status.completionAllowed ? "ALLOWED" : "BLOCKED"}: ${status.reason ?? "current deterministic PASS"}`,
                status.reviewMarkdown,
              ]
                .filter(Boolean)
                .join("\n\n")
            : status.reason,
      );
      process.exitCode = status.completionAllowed ? 0 : 1;
    } catch (e: any) {
      console.error(`status error: ${e.message}`);
      process.exitCode = 2;
    }
  });
program
  .command("completion")
  .description("Run the central deterministic gate and optional advisory AgentSmith review")
  .option("-c, --config <path>", "Path to quality.yaml")
  .option("--root <path>", "Project root", process.cwd())
  .option("--base <branch>", "Base branch")
  .option("--json", "JSON output", false)
  .action(async (opts) => {
    try {
      const result = await runQualityCompletion({
        cwd: opts.root,
        mode: "full",
        base: opts.base,
        configFlag: opts.config,
        tool: "quality completion",
        adapter: "cli",
      });
      console.log(opts.json ? JSON.stringify(result, null, 2) : result.reviewMarkdown);
      process.exitCode = result.passed ? 0 : 1;
    } catch (e: any) {
      console.error(`completion error: ${e.message}`);
      process.exitCode = 2;
    }
  });
program
  .command("review")
  .description("Run the deterministic gate and advisory AgentSmith review")
  .option("-c, --config <path>", "Path to quality.yaml")
  .option("--root <path>", "Project root", process.cwd())
  .option("--base <branch>", "Base branch")
  .option("--json", "JSON output", false)
  .action(async (opts) => {
    try {
      const result = await runQualityReview({
        cwd: opts.root,
        mode: "full",
        base: opts.base,
        configFlag: opts.config,
        tool: "quality review",
        adapter: "cli",
      });
      console.log(opts.json ? JSON.stringify(result, null, 2) : result.reviewMarkdown);
      process.exitCode = result.passed ? 0 : 1;
    } catch (e: any) {
      console.error(`review error: ${e.message}`);
      process.exitCode = 2;
    }
  });
program
  .command("fix")
  .description("Prepare a host-driven fix task for selected AgentSmith findings")
  .requiredOption("--review-version <version>", "Reviewed workspace version")
  .requiredOption("--finding <id...>", "Finding IDs")
  .option("--root <path>", "Project root", process.cwd())
  .action((opts) => {
    const task = prepareFix({ cwd: opts.root, reviewVersion: opts.reviewVersion, findingIds: opts.finding });
    console.log(JSON.stringify(task, null, 2));
    process.exit(task.status === "READY" ? 0 : 1);
  });
program
  .command("doctor")
  .description("Check environment capabilities")
  .option("-c, --config <path>", "Path to quality.yaml")
  .option("--root <path>", "Project root", process.cwd())
  .option("--json", "JSON output", false)
  .option("--markdown", "Markdown verification block", false)
  .action(async (opts) => {
    try {
      const res = runDoctor({ configFlag: opts.config, cwd: opts.root });
      if (opts.json) console.log(doctorToJson(res));
      else console.log(doctorToReport(res));
      process.exit(res.passed ? 0 : 1);
    } catch (e: any) {
      console.error(`doctor error: ${e.message}`);
      process.exit(2);
    }
  });
program
  .command("config")
  .description("Config utilities")
  .command("show")
  .option("-c, --config <path>", "Config path")
  .option("--root <path>", "Project root", process.cwd())
  .action(async (opts) => {
    const resolved = resolveConfig({ configFlag: opts.config, cwd: opts.root });
    console.log(
      JSON.stringify(
        {
          path: resolved.configPath,
          root: resolved.configRoot,
          isDefault: resolved.isDefault,
          manifest: resolved.isDefault
            ? null
            : {
                version: resolved.config.version,
                project: resolved.config.project,
                application: resolved.config.application,
                review: resolved.config.review,
                policy: resolved.config.policySource,
              },
        },
        null,
        2,
      ),
    );
  });

const traceCommand = program.command("trace").description("Inspect retained local AgentSmith traces");
traceCommand
  .command("status")
  .option("--root <path>", "Project root", process.cwd())
  .action((opts) => console.log(JSON.stringify(traceStatus(resolveConfig({ cwd: opts.root }).configRoot), null, 2)));
traceCommand
  .command("list")
  .option("--root <path>", "Project root", process.cwd())
  .action((opts) => {
    const root = resolveConfig({ cwd: opts.root }).configRoot;
    const summaries = listAgentSmithTraces(root).map((trace) => ({
      traceId: trace.traceId,
      createdAt: trace.createdAt,
      version: trace.version,
      status: trace.result.status,
      outcome: trace.result.outcome,
      mode: trace.result.mode,
      findings: trace.result.findings.length,
      errors: trace.result.errors?.length ?? 0,
    }));
    console.log(JSON.stringify(summaries, null, 2));
  });
traceCommand
  .command("show <trace-id>")
  .option("--root <path>", "Project root", process.cwd())
  .action((traceId, opts) => {
    const root = resolveConfig({ cwd: opts.root }).configRoot;
    console.log(JSON.stringify(readAgentSmithTrace(root, traceId), null, 2));
  });
await program.parseAsync(process.argv);
