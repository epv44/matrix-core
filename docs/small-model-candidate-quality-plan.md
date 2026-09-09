# Small-Model Candidate Quality Plan

## Status and authority

This document is the canonical index for the candidate-quality improvement campaign prompted by the component eval results and the Paladin architecture comparison.

It refines, but does not replace:

- `docs/small-model-review-roadmap.md`;
- `docs/codex-agent-swarm.md`;
- `docs/graph_aware_review_pipeline_migration.md`;
- `AGENTS.md`.

If these documents conflict, `AGENTS.md` and the existing roadmap constraints win. The phases in this plan execute sequentially. A later phase cannot begin until the orchestrator records the preceding phase as promoted.

Implementation agents must not edit this plan or its promotion criteria while implementing a phase. Changes to promotion criteria require a separate, human-reviewed documentation change before implementation begins.

## Evidence motivating the campaign

The latest complete suite artifact available when this plan was written was `.quality/evals/component-small-v4.json`. It recorded:

- 8 applicable positive gold findings;
- 6 selected gold findings;
- 0 expected candidates found;
- 0 verified gold findings;
- 6 model-attributed misses;
- 2 coverage/budget-attributed misses;
- 0/8 candidate evidence-request completeness.

Later focused budgeting runs established that Graph Retrieval, Planning, Ranking, Selection, and Projection can be healthy while Candidate Generation remains the first failing stage. The suite artifact predates some of those repairs, so it is diagnostic evidence, not the campaign's promotion baseline. Phase 0 must produce a fresh baseline from the current repository state.

The immediate bottleneck is candidate recognition and candidate evidence-request quality. Verifier optimization is deferred until valid gold candidates reach verification reliably.

## Campaign invariants

Every phase must preserve all of the following:

1. The frozen repository snapshot is the only source of model-facing code and evidence.
2. Work-item, token, evidence, model-call, and timeout budgets remain hard limits.
3. A model cannot widen repository scope or browse independently.
4. Deterministic code owns applicability, routing, validation, deduplication, ranking, aggregation, and reporting.
5. Model output cannot invent paths, locations, symbols, evidence, severity policy, or promotion status.
6. `PARTIAL`, timeout, provider failure, budget exhaustion, and insufficient context never become `PASS`.
7. Existing eval fixtures, thresholds, and expected findings cannot be weakened to make a phase pass.
8. Fixture-specific production behavior is prohibited.
9. The previous small-model path remains available until the final shadow-comparison phase passes.
10. Descriptor fingerprints are audit and stale-result controls, not proof that a model behaved correctly.
11. Same-model agreement is not verification evidence.
12. Correctness remains the default lens; initial routing may add at most one applicable specialist lens per unit.

## Promotion protocol shared by every phase

Before implementing a phase, the orchestrator must persist a pre-phase checkpoint containing:

- repository commit or immutable workspace identity;
- corpus hash;
- fixture/schema version;
- policy and configuration hashes;
- exact model profile and model digest;
- deterministic component-eval artifact;
- three-repetition live component-eval artifact where the phase affects model behavior;
- applicable per-case and aggregate metrics;
- work-item, token, evidence, call, and timeout limits.

After implementation, rerun the same applicable component evals under the same inputs and limits.

A phase may be promoted only when:

- all correctness and architectural checks pass;
- every previously passing applicable case remains passing;
- every existing applicable quality metric is directionally unchanged or improved at both aggregate and per-case level;
- no failure is hidden by an aggregate improvement;
- hard budget values are unchanged unless the phase explicitly exists to reduce a limit;
- partial/error/provider-unavailable rates do not increase;
- new metrics meet the absolute gate declared by the phase;
- a quality-improvement phase measurably improves its declared primary metric;
- required live results complete for three consecutive repetitions;
- an independent adversarial review finds no fixture-specific behavior, hidden scope widening, or weakened validation.

Directionality is interpreted as follows:

- recall, precision, validity, correctness, and completion rates: higher is better;
- false positives, misses, invalid locators, unresolved requests, omissions, calls, tokens, latency, partials, and errors: lower is better;
- deterministic identity, order, schema, and budget assertions: exact equality is required.

`N/A` values are excluded from denominators. A newly applicable metric is not compared numerically with an old `N/A`; it must instead satisfy the phase's absolute gate. Live comparisons use the same three-repetition protocol and compare aggregate values plus each fixture's worst result. Provider unavailability blocks promotion rather than producing a pass or a zero.

The default autonomous repair limit is three attempts per phase. After three failed attempts, the orchestrator records the phase as blocked with the failing cases, metric deltas, attempted repairs, and recommended next experiment.

## Subagent execution pattern

For each phase, the root Codex agent is the orchestrator and sole promotion authority. Use bounded subagents for:

- implementation;
- independent tests and evals;
- read-only adversarial review.

Parallel writers must have disjoint write scopes. Dependent work is serialized. The eval agent must independently calculate before/after deltas; a builder's test report is not promotion evidence. The reviewer must explicitly inspect budget enforcement, scope boundaries, deterministic behavior, fixture leakage, and failure-status semantics.

## Contents

- [Phase 0 — Candidate Measurement and Fresh Baseline](#phase-0--candidate-measurement-and-fresh-baseline)
- [Phase 1 — Typed Question and Result Contracts](#phase-1--typed-question-and-result-contracts)
- [Phase 2 — Focused Candidate Lenses](#phase-2--focused-candidate-lenses)
- [Phase 3 — Constrained Evidence Locator IDs](#phase-3--constrained-evidence-locator-ids)
- [Phase 4 — Descriptor Fingerprints and Stale-Result Rejection](#phase-4--descriptor-fingerprints-and-stale-result-rejection)
- [Phase 5 — Relationship-Preserving Unit Packing](#phase-5--relationship-preserving-unit-packing)
- [Phase 6 — Eval-Qualified Routing and Shadow Promotion](#phase-6--eval-qualified-routing-and-shadow-promotion)

## Phase sequence

| Phase | Primary outcome |
|---|---|
| 0 | Fresh baseline and candidate near-miss attribution |
| 1 | Typed question/result contracts in shadow mode |
| 2 | Eval-driven focused lenses for measured miss families |
| 3 | Constrained evidence locator IDs instead of invented strings |
| 4 | Reproducible descriptor identity and stale-result rejection |
| 5 | Relationship-preserving, token-bounded large-change packing |
| 6 | Eval-qualified routing, escalation, and final shadow comparison |

# Phase 0 — Candidate Measurement and Fresh Baseline

### Objective

Establish a reproducible post-repair baseline and make candidate misses diagnosable before changing candidate behavior.

This phase is observability-only. It must not change candidate prompts, model routing, selected context, evidence resolution, verification, or final findings.

### Required implementation

Add candidate near-miss diagnostics that compare an expected candidate with generated candidates along independent dimensions:

- changed-file and changed-region overlap;
- category and severity compatibility;
- concrete triggering-value recall;
- violated-invariant term recall;
- observable-impact term recall;
- title similarity as a diagnostic only;
- anchor validity and anchor distance;
- evidence-request completeness;
- evidence-request locator validity;
- whether a semantically relevant candidate was rejected only by the strict oracle.

The strict finding oracle remains unchanged. Near-miss diagnostics cannot turn a failure into a pass.

Persist a fresh component baseline from the current implementation. Do not overwrite an existing baseline artifact.

### Subagent decomposition

- Metrics builder: candidate-stage diagnostics and report plumbing.
- Eval agent: metric tests, fixture-independent near-miss cases, and baseline execution.
- Reviewer: read-only review for oracle weakening, accidental pass conversion, and fixture-term leakage.

Implementation and eval writers must use disjoint source and test/eval paths.

### Required validation

- metric unit tests;
- schema/report serialization tests;
- malformed and missing-candidate tests;
- `npm run build`;
- `npm run lint`;
- `npm run eval:check`;
- full component stage/isolated eval;
- full component live eval with three consecutive repetitions;
- MatrixCore changed and completion gates.

### Promotion gate

- Existing eval statuses and strict oracle results are byte-for-byte equivalent apart from new diagnostics and timing fields.
- Every previously reported stage metric is unchanged or improved.
- New near-miss dimensions are populated for every applicable positive fixture.
- Negative fixtures remain excluded from positive-candidate denominators.
- No new prompt tokens or model calls are introduced.
- The fresh baseline records corpus, schema, policy, config, model, and repository identities.
- Provider failure or an incomplete repetition blocks promotion.

### Checkpoint

Record immutable pre/post artifacts and designate the post-phase result as the comparison checkpoint for Phase 1. Baseline creation is observational and is not itself a promotion decision.

# Phase 1 — Typed Question and Result Contracts

### Objective

Define a bounded, reproducible question contract for small-model candidate work without activating new lenses in production.

### Required contracts

Each model-facing candidate task must be serializable with:

```text
task ID and version
snapshot ID
review-unit ID
lens ID and version
single review question
changed ranges
selected context references
allowed evidence-locator references
token/call/expansion limits
output-contract version
```

Candidate output must use a tri-state result:

```text
finding
no_finding
insufficient_context
```

A `finding` must include a changed-code anchor, triggering input/value, violated contract or invariant, observable impact, and typed evidence needs. `no_finding` cannot claim global approval. `insufficient_context` must identify the missing fact through the typed request vocabulary.

### Required behavior

Implement serialization, validation, and shadow construction first. Existing candidate execution remains authoritative during this phase. The shadow descriptor is traced and evaluated but cannot change findings or statuses.

Reject malformed states, missing finding fields, nonexistent ranges, out-of-scope references, invalid enum values, and result shapes that combine incompatible states.

### Subagent decomposition

- Contract builder: schemas, deterministic IDs, and serialization.
- Test agent: malformed-output and compatibility tests.
- Eval agent: shadow-equivalence metrics and component runs.
- Reviewer: read-only scope and compatibility review.

### Required component evals

- all Candidate-stage fixtures;
- all Snapshot through Projection fixtures to prove inputs are unchanged;
- benign/negative fixtures;
- full component suite at stage/isolated tier;
- three-repetition live component suite because descriptor construction touches model-dispatch boundaries.

### Promotion gate

- Shadow descriptor serialization is deterministic.
- Existing candidate prompts, outputs, oracle resolutions, and final findings do not regress.
- Selection and candidate-context recall remain unchanged or improve.
- Candidate recall and precision remain unchanged or improve.
- Token, call, partial, error, and invalid-output metrics remain unchanged or improve.
- Every invalid contract test is rejected deterministically.
- No production route consumes the shadow descriptor yet.

# Phase 2 — Focused Candidate Lenses

### Objective

Improve model-attributed candidate recall by replacing one broad question with a small, eval-driven set of narrowly scoped lens questions.

Extend the existing rule/lens registry. Do not create a second competing pass registry.

### Initial lens families

Introduce families only for measured component failures:

1. lifecycle and resource cleanup;
2. authentication and authorization boundaries;
3. null-return and caller contracts;
4. boundary arithmetic and off-by-one behavior;
5. producer/consumer unit and schema contracts;
6. finite-value provenance and user-visible mapping.

Each registered lens declares:

```text
stable ID and version
deterministic applicability predicates
one bounded question template
required result fields
allowed evidence kinds
maximum calls and input tokens
required evaluated model capability
owned eval fixtures
```

Correctness always runs. Initial routing may add at most one specialist lens per selected unit. Applicability is decided by deterministic AST/graph/risk signals, never by fixture identity or model preference.

### Execution order

Implement one lens family at a time as sub-phases 2A–2F. Each sub-phase must pass before the next family begins. This preserves causal attribution between a lens and metric movement.

### Subagent decomposition per family

- Lens builder: one registry entry and bounded prompt/task integration.
- Eval agent: family fixture plus at least one negative/sentinel fixture.
- Reviewer: read-only review for prompt leakage, duplicate calls, hypothetical findings, and false-positive suppression.

Do not let two builders modify shared routing or registry code concurrently.

### Required component evals per family

- the target positive fixture;
- its negative/sentinel fixture;
- all previously promoted lens fixtures;
- Candidate, Evidence, Verification, Aggregation, and Reporting stages;
- three consecutive live repetitions under the same model and budgets;
- a no-specialist-lens control over the same frozen corpus, selected units, model
  profile, budgets, and repetition count, with lens-attributable call, token, and
  latency deltas reported.

After 2F, run the complete component suite and produce a consolidated comparison.

### Control and efficiency accounting

The control run is the comparison point for specialist-lens cost. It must use
the same frozen inputs, selected units, model profile, budgets, and repetitions;
only the applicable specialist lens is disabled. Report, separately for the
control and lens-enabled runs:

- model-call count, input tokens, output tokens, total tokens, and latency;
- specialist-lens calls, tokens, and latency attributable to applicable lenses;
- newly recovered expected candidates attributable to the lens; and
- `tokensPerRecoveredGold = lensAttributableTokens /
  newlyRecoveredExpectedCandidates`.

Use the existing 15% efficiency convention for aggregate token usage:

- lens-enabled total tokens MUST be no more than 15% above the matched control;
- specialist-lens calls and tokens MUST remain within each lens's declared
  per-unit limits and the existing global hard budgets;
- hard global call and token limit values MUST remain unchanged and MUST never
  be exceeded;
- any increase in calls, tokens, or latency MUST be attributable to applicable
  specialist-lens execution and reported explicitly;
- `tokensPerRecoveredGold` MUST NOT materially regress, using the same 15%
  tolerance when a control comparison is defined;
- if no expected candidate is newly recovered, the ratio is `N/A`, but the
  family still fails because the target-recall gate was not met;
- if the control recovers zero candidates, the ratio comparison is `N/A`; use
  the aggregate 15% token cap, declared lens limits, and the recall gate.

Partial and error rates are strict non-regression gates. A latency increase
that is not explained by applicable lens execution fails the gate. No lens may
be routed to an inapplicable unit.

### Promotion gate per family

- Target-family expected-candidate recall measurably improves.
- Previously promoted family recall does not regress.
- Candidate precision and forbidden-candidate metrics remain unchanged or improve.
- Anchor validity and evidence-request completeness remain unchanged or improve.
- No extra lens is routed to an inapplicable unit.
- Specialist-lens calls and tokens stay within declared per-unit limits and
  existing global hard budgets.
- Any increase in calls, tokens, or latency is attributable to applicable
  specialist-lens execution and is reported in the control comparison.
- Aggregate total tokens remain within the 15% control tolerance, and
  `tokensPerRecoveredGold` does not materially regress.
- Partial and error rates remain unchanged or improve.
- Hard global call and token limit values remain unchanged and are never
  exceeded.
- Every previously passing case remains passing.

A lens that only increases candidate volume without improving target recall cannot be promoted.

# Phase 3 — Constrained Evidence Locator IDs

### Objective

Prevent candidates from inventing expression-shaped symbol locators while preserving the model's ability to request bounded supporting evidence.

### Required design

For each task, deterministic code builds an allowed locator table from the frozen work item and graph:

```text
locator ID
mode: symbol | literal | relationship | path
canonical value
allowed evidence kinds
optional path bound
snapshot identity
```

The model returns locator IDs, not raw symbol or path strings. Literal searches remain explicit and distinct from symbol lookup. Relationship requests identify a canonical source symbol and supported relationship kind.

Unknown, stale, duplicated, incompatible, or out-of-scope locator IDs are rejected. The engine must not silently reinterpret an invalid symbol expression as a valid literal.

### Subagent decomposition

- Contract builder: locator table and candidate-output schema.
- Resolver builder: ID-to-request resolution, serialized after contract integration if files overlap.
- Eval agent: valid, invalid, stale, and adversarial locator cases.
- Reviewer: read-only scope-widening and evidence-integrity review.

### Required component evals

- all fixtures with evidence requirements;
- all six positive candidate families from Phase 2;
- benign and false-positive fixtures;
- Evidence and Verification isolated-stage evals;
- complete component suite with three live repetitions.

### Promotion gate

- Canonical-locator validity is 100% for expected candidates.
- Evidence-request completeness and required evidence recall improve or remain unchanged.
- Candidate recall and precision do not regress.
- Invalid locator acceptance remains zero.
- No locator resolves outside its snapshot or task scope.
- Evidence, token, call, and expansion budgets remain unchanged.
- Partial/error/unresolved-request rates remain unchanged or improve.

# Phase 4 — Descriptor Fingerprints and Stale-Result Rejection

### Objective

Give every dispatched candidate task a reproducible identity suitable for trace correlation, cache keys, replay, and stale-result rejection.

This phase is behavior-neutral. A fingerprint is not a review-quality score, proof of model comprehension, or substitute for frozen-scope enforcement.

### Fingerprint input

Hash a canonical serialization of:

```text
snapshot ID
review-unit ID and content references
lens ID/version
question-contract version
allowed locator-table identity
token/call/expansion limits
model profile and relevant inference settings
output-contract version
```

The model result envelope carries the expected descriptor fingerprint. The engine verifies the envelope before accepting the result. Cache entries and replay artifacts must include the same identity.

### Required tests

- canonical serialization determinism;
- order-independent canonical fields where specified;
- one-bit input changes alter the fingerprint;
- stale result rejection;
- wrong snapshot/lens/schema/model identity rejection;
- cache and replay identity behavior;
- trace/report provenance.

### Subagent decomposition

- Fingerprint builder: canonical serialization and envelope validation.
- Test agent: mutation, stale-result, cache, and replay tests.
- Eval agent: behavior-equivalence comparison.
- Reviewer: read-only review of security claims and omitted hash inputs.

### Required component evals

- deterministic Snapshot through Reporting component evals;
- replay and cache tests;
- full component live suite with three repetitions to prove dispatch compatibility.

### Promotion gate

- Equivalent descriptors produce identical fingerprints.
- Materially different descriptors cannot share a fingerprint in the test corpus.
- Stale or mismatched results cannot enter Candidate Generation or later stages.
- Existing candidate/finding results and all quality metrics remain unchanged or improve.
- Calls, tokens, latency, partials, and errors remain unchanged or improve.

# Phase 5 — Relationship-Preserving Unit Packing

### Objective

Scale focused candidate review to large changes while keeping semantically necessary code together and preserving hard budgets.

MatrixCore continues to shard by changed symbol and interaction unit, not by arbitrary file slices.

### Required design

Add deterministic packing over already-ranked units:

- estimate complete task tokens, including question and locator contracts;
- keep required producer/consumer, caller/callee, schema/consumer, and implementation/interface pairs together;
- pack by token weight under the existing work-item and candidate-token limits;
- preserve incoming rank except for documented local/interaction reservation constraints;
- never split a declared minimum-evidence group;
- emit a deterministic omission reason when a required group cannot fit;
- do not increase budgets or truncate required evidence to force a fit.

Packing may improve utilization but must not recompute Ranking scores or let Selection independently rerank candidates.

### Subagent decomposition

- Packing builder: deterministic grouping and budget enforcement.
- Eval agent: large/noisy, cross-file, and adversarial packing fixtures.
- Test agent: determinism, tie-breaking, and hard-limit tests.
- Reviewer: read-only review for hidden reranking, scope widening, and budget bypasses.

### Required component evals

- Planning, Ranking, Selection, and Projection isolated evals;
- all cross-file and noisy-change component fixtures;
- all previously promoted candidate-lens fixtures;
- complete component suite with three live repetitions.

### Promotion gate

- Selection and candidate-context recall improve or remain unchanged globally and per case.
- The targeted large/noisy fixture metric measurably improves.
- Ranking order and documented reservation semantics remain correct.
- Work-item and token limits remain unchanged and are never exceeded.
- Candidate recall, precision, evidence completeness, and verified recall remain unchanged or improve.
- Calls, tokens, latency, omissions, partials, and errors remain unchanged or improve.
- No previously passing case regresses.

# Phase 6 — Eval-Qualified Routing and Shadow Promotion

### Objective

Route tasks only to model profiles that have demonstrated capability for the applicable lens, then compare the complete new candidate path with the previous path before replacement.

### Capability qualification

Capability is established by eval evidence, not model parameter count. For each model profile and lens version, persist:

```text
model/profile identity
lens ID/version
owned fixture corpus hash
candidate and verified recall
precision
locator/evidence validity
tokens, calls, and latency
partial/error rate
qualification status and checkpoint
```

A model/lens pair is qualified only after three consecutive live repetitions satisfy the lens gate. An unqualified pair must use a documented fallback, produce an escalation signal, or remain incomplete; it cannot silently substitute another model.

### Routing and escalation

Deterministic routing considers task/lens capability, required evidence complexity, configured availability, and hard budgets. Supported escalation reasons include:

- no qualified model for the lens;
- high-risk insufficient context;
- required relationship group cannot fit;
- architecture-level reasoning requirement;
- provider timeout or failure;
- partial execution.

Routing does not use parameter count alone and does not allow the model to select its own route.

### Shadow comparison

Run the previous and new small-model paths over the same frozen corpus, model identities, policy, configuration, and limits. Compare per case and in aggregate:

- selection and candidate-context recall;
- expected-candidate and verified-finding recall;
- candidate and verified precision;
- evidence-request completeness and locator validity;
- tokens, calls, latency, partials, errors, and escalation rate;
- all stage-specific component metrics.

The previous path remains intact throughout this phase.

### Subagent decomposition

- Routing builder: qualification records and deterministic routing.
- Shadow builder: comparison artifact without promotion authority.
- Eval agent: full repeated suite and per-lens qualification calculations.
- Reviewer: read-only review of substitution, fallback, partial/pass, and baseline semantics.

### Required validation

- routing and fallback unit tests;
- unavailable/unqualified model tests;
- `PARTIAL != PASS` and insufficient-context tests;
- shadow artifact schema and comparability tests;
- full deterministic component suite;
- old and new live component suites with three consecutive repetitions each;
- MatrixCore changed and completion gates.

### Promotion gate

- Every active small-model lens has a qualified route or an explicit non-pass escalation path.
- The new path measurably improves expected-candidate recall and verified-finding recall.
- Every previously passing case remains passing.
- No applicable quality, coverage, evidence, reliability, or efficiency metric regresses.
- Hard budgets and failure semantics remain unchanged.
- Shadow artifacts are directly comparable and reproducible.
- Independent review approves the architectural contract.

Only after this gate passes may a separate plan propose retiring the previous path. Retirement is not part of this phase.

## Explicitly deferred

The following are not part of this campaign unless a future eval-backed plan is approved:

- a full voice × pass matrix;
- dozens of binary yes/no prompts;
- same-model rephrased agreement as a confidence or verification signal;
- aggressive concurrency before lens quality and call budgets are stable;
- file-count-based sharding that can split semantic relationships;
- routing based only on parameter count;
- cryptographic sealing presented as a review-quality guarantee;
- removal of the broad/frontier review path.

## Campaign completion

The campaign is complete only after Phase 6 demonstrates, through a reproducible shadow comparison, that the new candidate path improves expected-candidate and verified-finding recall without regressing precision, selection/context coverage, budgets, reliability, or any previously passing component fixture.
