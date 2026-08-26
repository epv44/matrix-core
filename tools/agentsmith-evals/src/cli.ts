#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { resolveConfig } from "../../../src/core/config-resolver.js";
import { compareEvalReports, runEvalCases, type EvalMode, type EvalReplayMode } from "./eval.js";
import { corpusCoverage } from "./coverage.js";
import { attachFixture, curateTrace, inventory, validateEvalCases } from "./case.js";
import type { EvalStage } from "./stage-score.js";

const program = new Command();
program.name("eval:agentsmith").description("Repository-only AgentSmith diagnostic evaluation lab");

function root(value: string): string {
  return resolveConfig({ cwd: value }).configRoot;
}

program
  .command("inventory")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) => console.log(JSON.stringify(inventory(root(opts.root)), null, 2)));

program
  .command("curate")
  .requiredOption("--trace <trace-id>", "Retained local trace id")
  .requiredOption("--case <slug>", "Case slug")
  .option("--repo <path>", "Matching frozen repository to copy")
  .option("--trace-root <path>", "Repository containing the retained trace and source CAS")
  .option("--project <name>", "Source project name", "")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) =>
    console.log(
      JSON.stringify(
        curateTrace({
          root: root(opts.root),
          traceId: opts.trace,
          slug: opts.case,
          repo: opts.repo,
          traceRoot: opts.traceRoot,
          project: opts.project,
        }),
        null,
        2,
      ),
    ),
  );

program
  .command("attach-fixture")
  .requiredOption("--case <slug>", "Existing draft case slug")
  .requiredOption("--repo <path>", "Matching frozen repository")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) => {
    attachFixture({ root: root(opts.root), slug: opts.case, repo: opts.repo });
    console.log(JSON.stringify({ case: opts.case, fixture: true }, null, 2));
  });

program
  .command("validate")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) => {
    const result = validateEvalCases(root(opts.root));
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
  });

program
  .command("coverage")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) => console.log(JSON.stringify(corpusCoverage(root(opts.root)), null, 2)));

const modes: EvalMode[] = [
  "holistic",
  "partitioned-local",
  "partitioned-evidence",
  "partitioned-interactions",
  "hybrid",
];
const stages: EvalStage[] = [
  "snapshot",
  "graph",
  "projection",
  "planning",
  "candidates",
  "evidence",
  "verification",
  "aggregation",
  "reporting",
];

program
  .command("run")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .option("--case <slug...>", "Selected active cases")
  .option("--tier <tier>", "stage, recorded, isolated, live, or all", "stage")
  .option("--mode <mode>", "Review mode or all", "partitioned-interactions")
  .option("--stage <stage...>", "Selected pipeline stages")
  .option("--repeat <count>", "Runs per case and mode", "1")
  .option("--label <name>", "Human-readable run label")
  .option("--json", "Print JSON instead of Markdown", false)
  .action(async (opts) => {
    const repositoryRoot = root(opts.root);
    if (!["stage", "recorded", "isolated", "live", "all"].includes(opts.tier))
      throw new Error(`Invalid tier: ${opts.tier}`);
    if (![...modes, "all"].includes(opts.mode)) throw new Error(`Invalid mode: ${opts.mode}`);
    const selectedStages = opts.stage as EvalStage[] | undefined;
    if (selectedStages?.some((stage) => !stages.includes(stage))) throw new Error("Invalid pipeline stage");
    const repeat = Number.parseInt(opts.repeat, 10);
    if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`Invalid repeat count: ${opts.repeat}`);
    const selectedModes = opts.mode === "all" ? modes : [opts.mode as EvalMode];
    const tiers: EvalReplayMode[] = opts.tier === "all" ? ["stage", "recorded", "isolated", "live"] : [opts.tier];
    const reports = [];
    for (const tier of tiers)
      reports.push(
        await runEvalCases({
          root: repositoryRoot,
          slugs: opts.case,
          modes: selectedModes,
          repeat,
          replay: tier,
          stages: selectedStages,
          label: opts.label,
        }),
      );
    console.log(opts.json ? JSON.stringify(reports, null, 2) : reports.map((item) => item.markdown).join("\n\n"));
    if (reports.some((report) => report.cases.some((item) => item.results.some((result) => result.errors.length))))
      process.exitCode = 1;
  });

program
  .command("compare <baseline> <current>")
  .option("--json", "Print JSON", false)
  .action((baseline, current, opts) => {
    const before = JSON.parse(fs.readFileSync(path.resolve(baseline), "utf8"));
    const after = JSON.parse(fs.readFileSync(path.resolve(current), "utf8"));
    const comparison = compareEvalReports(before, after);
    console.log(opts.json ? JSON.stringify(comparison, null, 2) : JSON.stringify(comparison, null, 2));
  });

await program.parseAsync(process.argv);
