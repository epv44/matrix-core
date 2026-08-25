import type { AgentSmithConfig, ModelProfile } from "../../../src/core/types.js";
import type { AgentSmithTrace } from "../../../src/agentsmith/trace.js";
import type { ProviderResponse, ReviewOutputKind, ReviewProvider } from "../../../src/agentsmith/provider.js";

interface Cassette {
  outputKind: ReviewOutputKind;
  model: string;
  prompt: string;
  response: ProviderResponse;
  used: boolean;
}

function traceCassettes(trace: AgentSmithTrace): Cassette[] {
  const execution = trace.execution;
  if (!execution) return [];
  const rawProfiles = execution.modelProfiles as unknown;
  const profiles = Array.isArray(rawProfiles)
    ? { candidate: rawProfiles[0] as ModelProfile, verifier: (rawProfiles[1] ?? rawProfiles[0]) as ModelProfile }
    : execution.modelProfiles;
  const values: Cassette[] = [];
  for (const batch of execution.candidateBatches)
    if (batch.prompt !== undefined && batch.raw !== undefined)
      values.push({
        outputKind: "candidates",
        model: profiles.candidate.model,
        prompt: batch.prompt,
        response: {
          raw: batch.raw,
          usage: { inputTokens: batch.inputTokens, outputTokens: batch.outputTokens },
          completion: batch.completion,
        },
        used: false,
      });
  if (execution.scout)
    values.push({
      outputKind: "scout",
      model: profiles.scout?.model ?? profiles.candidate.model,
      prompt: execution.scout.prompt,
      response: {
        raw: execution.scout.raw,
        usage: { inputTokens: execution.scout.inputTokens, outputTokens: execution.scout.outputTokens },
        completion: execution.scout.completion,
      },
      used: false,
    });
  for (const verification of execution.verification)
    if (verification.prompt !== undefined && verification.raw !== undefined)
      values.push({
        outputKind: "verification",
        model: profiles.verifier.model,
        prompt: verification.prompt,
        response: {
          raw: verification.raw,
          usage: { inputTokens: 0, outputTokens: 0 },
          completion: verification.completion,
        },
        used: false,
      });
  return values;
}

export class RecordedReviewProvider implements ReviewProvider {
  private readonly cassettes: Cassette[];
  private readonly models: string[];

  constructor(trace: AgentSmithTrace) {
    this.cassettes = traceCassettes(trace);
    const rawProfiles = trace.execution?.modelProfiles as unknown;
    const profiles = Array.isArray(rawProfiles) ? rawProfiles : Object.values(trace.execution?.modelProfiles ?? {});
    const runtimeModels = Object.values(trace.result?.runtime?.models ?? {}).filter(
      (model): model is string => typeof model === "string",
    );
    this.models = [
      ...new Set([
        ...profiles.filter((profile): profile is ModelProfile => Boolean(profile)).map((profile) => profile.model),
        ...runtimeModels,
      ]),
    ];
  }

  async health() {
    return { ok: true, models: this.models };
  }

  async invoke(input: Parameters<ReviewProvider["invoke"]>[0]): Promise<ProviderResponse> {
    const cassette = this.cassettes.find(
      (candidate) =>
        !candidate.used &&
        candidate.outputKind === input.outputKind &&
        candidate.model === input.profile.model &&
        candidate.prompt === input.prompt,
    );
    if (!cassette)
      throw new Error(
        `Recorded replay miss for ${input.outputKind} using ${input.profile.model}; prompt or strategy changed`,
      );
    cassette.used = true;
    return structuredClone(cassette.response);
  }
}

export class PlannerReviewProvider implements ReviewProvider {
  constructor(private readonly config: AgentSmithConfig) {}

  async health() {
    return { ok: true, models: [...new Set(this.config.model_profiles.map((profile) => profile.model))] };
  }

  async invoke(input: Parameters<ReviewProvider["invoke"]>[0]): Promise<ProviderResponse> {
    return {
      raw:
        input.outputKind === "scout"
          ? '{"hotspots":[]}'
          : input.outputKind === "verification"
            ? '{"verdict":"rejected","confidence":1,"supportingEvidenceIds":[]}'
            : '{"c":[]}',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}
