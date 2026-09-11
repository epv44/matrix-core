import { sha256Json } from "../core/hash.js";

export const AGENTSMITH_STRATEGY_VERSION = 5;
export const AGENTSMITH_STRATEGY_HASH = sha256Json({
  version: AGENTSMITH_STRATEGY_VERSION,
  reviewPaths: "generic-small-specialist-strong-full-fit-v1",
  candidateSchema: "compact-json-claim-directed-semantic-selector-v6",
  graphProjection: "auditable-risk-diverse-selection-v2",
  evidenceResolution: "strict-request-outcomes-token-packed-v2",
  evidenceSelectorCompilation: "host-resolved-selector-to-canonical-hash-v1",
  completionSemantics: "citation-repair-required-evidence-v2",
});
