import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type CandidateCall = {
  sourceId?: string;
  prompt?: string;
  raw?: string;
  thinking?: string;
  reasoningSummary?: string;
  inputTokens?: number;
  outputTokens?: number;
  completion?: unknown;
  error?: string;
  descriptorFingerprint?: string;
  contract?: {
    candidateArm?: string;
    inferenceMode?: string;
    promptVariant?: string;
    systemPromptSha256?: string;
    outputSchemaSha256?: string;
  };
};

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseFinal(raw: string | undefined) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { invalidJson: true, raw };
  }
}

function localDeleteUserCalls(report: any): CandidateCall[] {
  return (report.reports?.[0]?.cases?.[0]?.results ?? [])
    .flatMap((result: any) => result.diagnostics?.candidateCalls ?? [])
    .filter((call: CandidateCall) => call.sourceId?.startsWith("local:") && call.prompt?.includes("deleteUser"));
}

function contractProjection(report: any) {
  const config = report.configuration ?? {};
  return {
    suite: config.suite,
    modelTarget: config.modelTarget,
    cases: config.cases,
    candidateArm: config.candidateArm,
    inferenceMode: config.inferenceMode,
    candidatePromptVariant: config.candidatePromptVariant,
    controlFlowDelta: config.controlFlowDelta,
    candidateTemperature: config.candidateTemperature,
    candidateTopP: config.candidateTopP,
    candidateTopK: config.candidateTopK,
  };
}

function assertEqual(label: string, left: unknown, right: unknown) {
  if (JSON.stringify(left) !== JSON.stringify(right))
    throw new Error(`Matched diagnostic contract mismatch: ${label}`);
}

async function main() {
  const smallPath = option("--small-report");
  const controlPath = option("--control-report");
  const output = option("--output");
  if (!smallPath || !controlPath || !output)
    throw new Error("Usage: matched-model-diagnostic --small-report <report.json> --control-report <report.json> --output <comparison.json>");
  const [small, control] = await Promise.all([
    readFile(path.resolve(smallPath), "utf8").then(JSON.parse),
    readFile(path.resolve(controlPath), "utf8").then(JSON.parse),
  ]);
  assertEqual("evaluation configuration", contractProjection(small), contractProjection(control));
  const smallCalls = localDeleteUserCalls(small);
  const controlCalls = localDeleteUserCalls(control);
  if (!smallCalls.length || !controlCalls.length)
    throw new Error("Both reports must contain at least one local deleteUser candidate call");
  const compact = (call: CandidateCall, modelRole: "small" | "control", index: number) => ({
    modelRole,
    repetition: index,
    sourceId: call.sourceId,
    promptSha256: sha256(call.prompt ?? ""),
    descriptorFingerprint: call.descriptorFingerprint ?? null,
    contract: call.contract ?? null,
    inputTokens: call.inputTokens ?? 0,
    outputTokens: call.outputTokens ?? 0,
    completion: call.completion ?? null,
    finalCandidate: parseFinal(call.raw),
    ...(modelRole === "small" ? { thinking: call.thinking ?? null } : { reasoningSummary: call.reasoningSummary ?? null }),
    error: call.error ?? null,
  });
  const smallFingerprints = smallCalls.map((call) => ({ prompt: sha256(call.prompt ?? ""), contract: call.contract ?? null }));
  const controlFingerprints = controlCalls.map((call) => ({ prompt: sha256(call.prompt ?? ""), contract: call.contract ?? null }));
  assertEqual("local deleteUser prompt and candidate contract", smallFingerprints, controlFingerprints);
  const body = {
    schemaVersion: 1,
    purpose: "diagnostic-only matched comparison; excluded from promotion and baseline decisions",
    generatedAt: new Date().toISOString(),
    sharedContract: contractProjection(small),
    promptAndContractMatch: true,
    sources: { smallReport: path.resolve(smallPath), controlReport: path.resolve(controlPath) },
    calls: [
      ...smallCalls.map((call, index) => compact(call, "small", index)),
      ...controlCalls.map((call, index) => compact(call, "control", index)),
    ],
    interpretation: {
      smallThinking: "Raw local-model thinking trace retained for diagnostic analysis.",
      controlReasoning: "Only the Responses API reasoning summary is retained; raw chain-of-thought is unavailable and not requested.",
      finalCandidates: "Both providers' final structured candidate JSON is retained verbatim or marked invalid.",
    },
  };
  const resolvedOutput = path.resolve(output);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, JSON.stringify(body, null, 2));
  console.log(JSON.stringify({ output: resolvedOutput, localCalls: smallCalls.length, controlCalls: controlCalls.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
