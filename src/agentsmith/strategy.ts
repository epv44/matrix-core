import crypto from "node:crypto";

export const AGENTSMITH_STRATEGY_VERSION = 4;
export const AGENTSMITH_STRATEGY_HASH = crypto
  .createHash("sha256")
  .update(
    JSON.stringify({
      version: AGENTSMITH_STRATEGY_VERSION,
      reviewPaths: "generic-small-specialist-strong-full-fit-v1",
      candidateSchema: "compact-json-required-locator-v3",
      graphProjection: "canonical-provider-facts-v1",
      evidenceResolution: "deduplicated-token-packed-v1",
      completionSemantics: "adjudication-based-v1",
    }),
  )
  .digest("hex");
