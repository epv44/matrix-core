#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { resolveConfig } from "../../../src/core/config-resolver.js";
import { compareEvalReports, runEvalCases, type EvalMode, type EvalReplayMode } from "./eval.js";
import { corpusCoverage } from "./coverage.js";
import { attachFixture, corpusHash, curateTrace, inventory, listEvalCases, validateEvalCases } from "./case.js";
import type { EvalStage } from "./stage-score.js";
import {
  htmlCompanionJsonPath,
  runEvalSuite,
  type EvalSuiteBaseline,
  type EvalSuiteOutputFormat,
} from "./suite.js";
import { renderEvalHtml } from "./html-report.js";
import type { CandidateGenerationArm, CandidateInferenceMode, CandidatePromptVariant } from "../../../src/agentsmith/engine-types.js";
import { findLatestSuiteStatus, readSuiteRunStatus } from "./suite-status.js";
import {
  readStage1Baseline,
  summarizeStage1Baseline,
  validateStage1Promotion,
  writeStage1Baseline,
  type Stage1EvalReport,
} from "./stage-1.js";
import { resolveEvalTreatment } from "./vllm-treatment.js";

const program = new Command();
program.name("eval").description("Repository-only AgentSmith diagnostic evaluation lab");

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

program
  .command("status")
  .description("Inspect a running or completed registered suite")
  .argument("[run-id]", "Suite run ID (defaults to the most recently updated run)")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .option("--json", "Print JSON instead of a human-readable summary", false)
  .action((runId: string | undefined, opts) => {
    const repositoryRoot = root(opts.root);
    const selected = runId
      ? (() => {
          const file = path.join(repositoryRoot, ".quality", "evals", "suites", runId, "status.json");
          return fs.existsSync(file) ? { path: file, status: readSuiteRunStatus(file) } : null;
        })()
      : findLatestSuiteStatus(repositoryRoot);
    if (!selected) throw new Error(runId ? `Suite status not found: ${runId}` : "No suite status files found");
    if (opts.json) {
      console.log(JSON.stringify({ ...selected.status, statusPath: selected.path }, null, 2));
      return;
    }
    const current = selected.status.current;
    console.log(
      [
        `Suite ${selected.status.runId}: ${selected.status.state}`,
        `Progress: ${selected.status.completedRuns}/${selected.status.plannedRuns} completed; ${selected.status.remainingRuns} remaining`,
        `Elapsed: ${(selected.status.elapsedMs / 1000).toFixed(1)}s; tokens ${selected.status.totals.inputTokens + selected.status.totals.outputTokens}; model calls ${selected.status.totals.modelCalls}`,
        current
          ? `Current: ${current.tier} · ${current.caseId} · ${current.mode} · repetition ${current.iteration + 1}`
          : "Current: not started",
        `Status file: ${selected.path}`,
        ...(selected.status.lastError ? [`Last error: ${selected.status.lastError}`] : []),
      ].join("\n"),
    );
  });

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
  "planning",
  "ranking",
  "selection",
  "projection",
  "candidates",
  "evidence",
  "verification",
  "aggregation",
  "reporting",
];
const candidateArms: CandidateGenerationArm[] = [
  "host-defaults",
  "deterministic-evidence",
  "host-derived-metadata",
  "simplified-contract",
  "rule-bound-classification",
  "host-referenced-witness",
];

async function runTargetEval(opts: {
  target?: string;
  suite?: string;
  model: "small" | "large";
  format: EvalSuiteOutputFormat;
  output?: string;
  baseline?: string;
  createBaseline?: string;
  root: string;
  progress?: boolean;
  tier?: EvalReplayMode;
  stages?: EvalStage[];
  repeat?: number;
  arm?: CandidateGenerationArm;
  inferenceMode?: CandidateInferenceMode;
  candidatePromptVariant?: CandidatePromptVariant;
  candidateModel?: string;
  verifierModel?: string;
  cases?: string[];
  timeoutMs?: number;
  candidateOutputTokens?: number;
  candidateContextTokens?: number;
  candidateTemperature?: number;
  candidateTopP?: number;
  candidateTopK?: number;
  candidateThinkingTokens?: number;
  thinkingStream?: boolean;
  treatment?: string;
}) {
  if (opts.target !== "agentsmith") throw new Error(`Unsupported eval target: ${opts.target ?? "<missing>"}`);
  if (!opts.suite) throw new Error("--suite is required");
  if (opts.baseline && opts.createBaseline) throw new Error("--baseline cannot be combined with --create-baseline");
  const replay = opts.tier ?? "live";
  if (!["stage", "recorded", "isolated", "live"].includes(replay)) throw new Error(`Invalid tier: ${replay}`);
  const repeat = opts.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error(`Invalid repeat count: ${repeat}`);
  if (opts.stages?.some((stage) => !stages.includes(stage))) throw new Error("Invalid pipeline stage");
  if (opts.arm && !candidateArms.includes(opts.arm)) throw new Error(`Invalid candidate arm: ${opts.arm}`);
  if (opts.inferenceMode && !["structured", "thinking-no-format", "thinking-structured", "thinking-conclusion-then-structured"].includes(opts.inferenceMode)) throw new Error(`Invalid candidate inference mode: ${opts.inferenceMode}`);
  const promptVariants: CandidatePromptVariant[] = ["baseline", "branch-analysis-v1", "branch-analysis-state-scan-v2", "branch-analysis-delta-first-v3", "branch-analysis-type-outcome-v2", "branch-analysis-guard-pass-through-v2"];
  if (opts.candidatePromptVariant && !promptVariants.includes(opts.candidatePromptVariant)) throw new Error(`Invalid candidate prompt variant: ${opts.candidatePromptVariant}`);
  if (opts.candidatePromptVariant !== "baseline" && opts.arm && !["simplified-contract", "rule-bound-classification", "host-referenced-witness"].includes(opts.arm))
    throw new Error("Branch-analysis prompt variants are only supported by the simplified-contract, rule-bound-classification, or host-referenced-witness arms");
  if (opts.inferenceMode === "thinking-conclusion-then-structured" && opts.arm && opts.arm !== "simplified-contract")
    throw new Error("thinking-conclusion-then-structured is only supported by the simplified-contract arm");
  if (opts.thinkingStream && !opts.inferenceMode?.startsWith("thinking-"))
    throw new Error("--thinking-stream requires a thinking inference mode");
  const treatment = resolveEvalTreatment(opts.treatment);
  if (treatment && (opts.candidateModel || opts.verifierModel || opts.candidateOutputTokens !== undefined || opts.candidateContextTokens !== undefined || opts.candidateTopP !== undefined || opts.candidateTopK !== undefined || opts.candidateThinkingTokens !== undefined || opts.timeoutMs !== undefined || opts.arm || opts.inferenceMode !== "structured" || opts.thinkingStream))
    throw new Error("--treatment only permits --candidate-temperature and --candidate-prompt-variant experimental overrides");
  if ((opts.baseline || opts.createBaseline) && (replay !== "live" || opts.stages?.length))
    throw new Error("Suite baselines are only supported for the complete live suite");
  const repositoryRoot = root(opts.root);
  const baselinePath = opts.baseline ? path.resolve(repositoryRoot, opts.baseline) : null;
  if (baselinePath && !fs.existsSync(baselinePath)) throw new Error(`Baseline file not found: ${baselinePath}`);
  const baseline = baselinePath
    ? (JSON.parse(fs.readFileSync(baselinePath, "utf8")) as EvalSuiteBaseline)
    : undefined;
  const htmlOutput =
    opts.format === "html"
      ? path.resolve(repositoryRoot, opts.output ?? path.join(".quality", "evals", "report.html"))
      : null;
  const jsonOutput = htmlOutput ? htmlCompanionJsonPath(htmlOutput) : opts.output;
  const suite = await runEvalSuite({
    root: repositoryRoot,
    suite: opts.suite,
    modelTarget: opts.model,
    replay,
    stages: opts.stages,
    repeat,
    candidateArm: treatment?.candidateArm ?? opts.arm,
    inferenceMode: treatment?.inferenceMode ?? opts.inferenceMode,
    candidatePromptVariant: opts.candidatePromptVariant === "baseline" ? treatment?.candidatePromptVariant ?? opts.candidatePromptVariant : opts.candidatePromptVariant,
    candidateModel: opts.candidateModel,
    verifierModel: opts.verifierModel,
    candidateTemperature: opts.candidateTemperature ?? treatment?.candidateTemperature,
    candidateTopP: treatment?.candidateTopP ?? opts.candidateTopP,
    candidateTopK: treatment?.candidateTopK ?? opts.candidateTopK,
    candidateThinkingTokens: treatment?.candidateThinkingTokens ?? opts.candidateThinkingTokens,
    thinkingStream: treatment?.thinkingStream ?? opts.thinkingStream,
    controlFlowDelta: treatment?.controlFlowDelta,
    timeoutMs: treatment?.timeoutMs ?? opts.timeoutMs,
    treatment: opts.treatment,
    cases: opts.cases,
    candidateOutputTokens: opts.candidateOutputTokens,
    candidateContextTokens: opts.candidateContextTokens,
    output: jsonOutput,
    baseline,
    baselineOutput: opts.createBaseline,
    onStart: (status) =>
      console.error(
        `Suite ${status.suite} (${status.modelTarget}) ${status.runId} started\nStatus: ${suiteStatusPathForCli(repositoryRoot, status.runId)}`,
      ),
    onProgress: opts.progress === false ? undefined : (status, event) =>
      console.error(
        `[${status.completedRuns}/${status.plannedRuns}] ${event.caseId} · ${event.mode} · ${event.status}`,
      ),
  });
  if (htmlOutput) {
    fs.mkdirSync(path.dirname(htmlOutput), { recursive: true });
    fs.writeFileSync(
      htmlOutput,
      renderEvalHtml({ run: suite, suite: suite.suite, baseline: suite.baseline?.definition, comparison: suite.comparison }),
    );
    console.log(
      [
        `HTML: ${htmlOutput}`,
        `Companion JSON: ${suite.output}`,
        ...(suite.baselineOutput ? [`Baseline: ${suite.baselineOutput}`] : []),
        ...(suite.baselineError ? [`Baseline error: ${suite.baselineError}`] : []),
      ].join("\n"),
    );
  } else if (opts.format === "json") console.log(JSON.stringify(suite, null, 2));
  else if (opts.createBaseline)
    console.log(
      [
        `Result JSON: ${suite.output}`,
        ...(suite.baselineOutput ? [`Baseline: ${suite.baselineOutput}`] : []),
        ...(suite.baselineError ? [`Baseline error: ${suite.baselineError}`] : []),
      ].join("\n"),
    );
  else
    console.log(
      [
        `AgentSmith suite: ${suite.suite}`,
        `Model: ${suite.modelTarget}`,
        `Eval status: ${suite.evalStatus}`,
        `Execution status: ${suite.executionStatus}`,
        `Cases: ${suite.corpus.activeCount}`,
        `Result JSON: ${suite.output}`,
        ...(suite.baselineOutput ? [`Baseline: ${suite.baselineOutput}`] : []),
      ].join("\n"),
    );
  if (suite.baselineError || (opts.createBaseline && !suite.baselineOutput)) process.exitCode = 1;
  else if (!opts.createBaseline && (suite.evalStatus !== "pass" || suite.baseline?.validation?.ok === false)) process.exitCode = 1;
}

function suiteStatusPathForCli(repositoryRoot: string, runId: string): string {
  return path.join(repositoryRoot, ".quality", "evals", "suites", runId, "status.json");
}

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
  .command("html <input>")
  .description("Render a suite or eval JSON artifact as a self-contained HTML walkthrough")
  .action((input, _opts, command) => {
    const opts = command.optsWithGlobals();
    const repositoryRoot = root(opts.root ?? process.cwd());
    const source = path.resolve(repositoryRoot, input);
    const report = JSON.parse(fs.readFileSync(source, "utf8"));
    const output = path.resolve(repositoryRoot, opts.output ?? "eval-report.html");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, renderEvalHtml(report));
    console.log(output);
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

const baseline = program.command("baseline").description("Create and validate reproducible migration baselines");

baseline
  .command("create")
  .requiredOption("--stage-result <path>", "Two-repetition deterministic stage eval result")
  .requiredOption("--live-result <path>", "Three-repetition live eval result")
  .option("--output <path>", "Baseline output", "evals/agentsmith/baselines/stage-1.json")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) => {
    const repositoryRoot = root(opts.root);
    const stageResult = JSON.parse(fs.readFileSync(path.resolve(opts.stageResult), "utf8")) as Stage1EvalReport;
    const liveResult = JSON.parse(fs.readFileSync(path.resolve(opts.liveResult), "utf8")) as Stage1EvalReport;
    const created = summarizeStage1Baseline(stageResult, liveResult);
    const output = path.resolve(repositoryRoot, opts.output);
    writeStage1Baseline(output, created);
    console.log(JSON.stringify({ output, corpusHash: created.corpusHash, promotionReady: true }, null, 2));
  });

baseline
  .command("validate")
  .option("--baseline <path>", "Stage 1 baseline", "evals/agentsmith/baselines/stage-1.json")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .action((opts) => {
    const repositoryRoot = root(opts.root);
    const baselinePath = path.resolve(repositoryRoot, opts.baseline);
    const activeCases = listEvalCases(repositoryRoot);
    const validation = validateStage1Promotion({
      baseline: readStage1Baseline(baselinePath),
      currentCorpusHash: corpusHash(repositoryRoot, activeCases),
    });
    console.log(JSON.stringify({ stage: 1, baseline: baselinePath, activeCases, ...validation }, null, 2));
    if (!validation.ok) process.exitCode = 1;
  });

program
  .option("--target <target>", "Evaluation target (agentsmith)")
  .option("--suite <suite>", "One registered AgentSmith eval suite")
  .option("--model <model>", "Model target: small or large", "small")
  .option("--format <format>", "Output format: text, json, or html", "text")
  .option("--output <path>", "JSON or HTML output path")
  .option("--baseline <path>", "Suite/model baseline to compare")
  .option("--create-baseline <path>", "Create an observational baseline from a complete suite run")
  .option("--root <path>", "MatrixCore repository root", process.cwd())
  .option("--no-progress", "Disable live progress updates")
  .option("--tier <tier>", "Suite replay tier: stage, recorded, isolated, or live", "live")
  .option("--stage <stage...>", "Run only the selected pipeline stage(s)")
  .option("--repeat <count>", "Runs per case", (value) => Number(value), 1)
  .option("--arm <arm>", `Candidate arm: ${candidateArms.join(", ")}`)
  .option("--inference-mode <mode>", "Candidate inference mode: structured, thinking-no-format, thinking-structured, or thinking-conclusion-then-structured", "structured")
  .option("--candidate-prompt-variant <variant>", "Candidate prompt variant: baseline, branch-analysis-v1, branch-analysis-state-scan-v2, branch-analysis-delta-first-v3, branch-analysis-type-outcome-v2, or branch-analysis-guard-pass-through-v2", "baseline")
  .option("--candidate-model <model>", "Override the candidate model for diagnostic evals only")
  .option("--verifier-model <model>", "Override the verifier model for diagnostic evals only")
  .option("--case <case...>", "Limit the diagnostic run to selected eval cases")
  .option("--timeout-ms <milliseconds>", "Override model request timeout for this eval", (value) => Number(value))
  .option("--candidate-output-tokens <tokens>", "Override candidate model output budget for this diagnostic eval", (value) => Number(value))
  .option("--candidate-context-tokens <tokens>", "Override candidate model context budget for this diagnostic eval", (value) => Number(value))
  .option("--candidate-temperature <temperature>", "Override candidate temperature for this diagnostic eval", (value) => Number(value))
  .option("--candidate-top-p <value>", "Override candidate top-p for this diagnostic eval", (value) => Number(value))
  .option("--candidate-top-k <value>", "Override candidate top-k for this diagnostic eval", (value) => Number(value))
  .option("--candidate-thinking-tokens <tokens>", "Override vLLM reasoning token budget for this diagnostic eval", (value) => Number(value))
  .option("--thinking-stream", "Stream and persist provider thinking chunks for diagnostics", false)
  .option("--treatment <id>", "Named reproducible provider treatment")
  .action(async (opts) => {
    if (!opts.target && !opts.suite) throw new Error("--target agentsmith and --suite <registered-suite> are required");
    if (opts.model !== "small" && opts.model !== "large") throw new Error(`Invalid model target: ${opts.model}`);
    if (!["text", "json", "html"].includes(opts.format)) throw new Error(`Invalid eval format: ${opts.format}`);
    await runTargetEval({
      ...opts,
      model: opts.model,
      format: opts.format,
      cases: opts.case,
      stages: opts.stage,
    });
  });

await program.parseAsync(process.argv);
