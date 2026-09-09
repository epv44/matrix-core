# Graph-Aware Review Pipeline Migration

## Objective

Split the current combined Planning / Ranking / Selection evaluation into independently testable components, add rigorous graph-completeness metrics, make canonical graph degree influence ranking in a bounded way, preserve hard selection constraints, and migrate reporting/baselines without losing historical comparability.

This is a Stage 4 behavioral change because it modifies graph-derived risk scoring and ranking/selection behavior. Reporting and baseline migration also affect Stage 5 observability.

The existing baseline is immutable. New or redefined metrics are non-comparable until a replacement observational baseline is created after all correctness gates pass.

---

## Non-Goals

This change does **not**:

- Add new review product features.
- Change hard work-item limits.
- Change hard token limits.
- Introduce edge-kind-weighted degree.
- Introduce confidence-weighted degree.
- Replace existing semantic risk signals.
- Change candidate generation semantics beyond what is required for the component split.
- Treat baseline creation as a promotion decision.
- Remove existing end-to-end evaluation coverage.
- Reintroduce raw-data payloads into HTML reports.

---

# Global Invariants

These invariants are normative and apply to every phase and sub-agent.

## G1. Component isolation

Component evaluations must use frozen canonical upstream inputs so that an upstream failure does not automatically count as a downstream component failure.

## G2. Canonical graph semantics

Duplicate graph observations must not increase structural degree.

## G3. Degree is bounded

Degree may affect ranking priority, but degree alone must not overwhelm protected semantic risk classes.

## G4. Ranking owns ordering

Ranking is the only component allowed to compute or modify risk scores and risk ordering.

## G5. Selection does not rerank

Selection must not recompute risk or independently rerank candidates except where a documented reservation rule forces a constrained deviation from strict rank order.

## G6. Budgets remain hard

Work-item and token budgets remain hard limits.

## G7. N/A is excluded

Metrics that are not applicable must be reported as N/A and excluded from aggregate denominators.

## G8. Historical baselines are immutable

Existing baseline artifacts must never be destructively overwritten.

## G9. Baseline creation is observational

Creating a replacement baseline is not a promotion decision.

## G10. Tests must not be weakened to make implementation pass

If a phase fails, repair the implementation or the genuinely incorrect fixture. Do not relax a valid contract, threshold, or oracle merely to obtain a passing result.

---

# Component Contracts

## Graph Retrieval

### Input

- Repository snapshot.
- Graph extraction inputs.

### Output

- Canonical graph manifest.

### Oracle

- Fixture-declared canonical nodes and edges.
- Explicit exhaustive graph scope.

### Responsibilities

Graph Retrieval owns:

- Graph completeness.
- Graph correctness.
- Edge identity/canonicalization behavior.
- Retrieval of expected graph relationships.

### Metrics

Report:

- Micro edge recall.
- Micro edge precision.
- Per-node adjacency recall.
- Macro adjacency recall.
- Minimum node adjacency recall.
- Fan-in correctness.
- Fan-out correctness.
- Neighbor-degree correctness.
- Directed incident-degree correctness.
- High-degree-node recall.
- Missing-edge count.
- Unexpected-edge count.
- Applicable fixture count.
- Applicable node count.

### Canonicalization rules

Use existing canonical edge-identity semantics.

- Duplicate observations do not increase degree.
- Multiple edge kinds between the same node pair count once for adjacency degree.
- Self-edges do not contribute to degree.
- Edges entirely outside declared labeled scope are excluded from false-positive calculations.

---

## Planning

### Input

- Frozen canonical graph manifest supplied by the fixture.

### Output

- Route.
- Candidate work items.
- Local units.
- Interaction units.
- Risk factors.
- Eligibility.

### Responsibilities

Planning owns:

- Route choice.
- Work-item construction.
- Local/interaction unit generation.
- Risk-factor computation.
- Graph-derived factor computation.
- Candidate eligibility.

### Metrics

Report:

- Route correctness.
- Candidate-unit coverage.
- Local-unit coverage.
- Interaction-unit coverage.
- Risk-factor availability.
- Risk-factor value accuracy.
- Graph-factor coverage.
- Exact fan-in correctness.
- Exact fan-out correctness.
- Exact degree correctness.
- Eligibility correctness.

A risk factor that exists but has the wrong value is:

- available;
- incorrect.

Planning component evaluation must not depend on Graph Retrieval succeeding in the same run.

---

## Ranking

### Input

- Frozen candidate work items.
- Frozen risk-factor values.

### Output

- Risk scores.
- Deterministic full ordering.
- Pairwise ordering results.

### Responsibilities

Ranking owns:

- Risk-score calculation.
- Degree contribution.
- Deterministic ordering of all eligible work items.
- Tie-breaking.

### Metrics

Report:

- Risk-order recall.
- Pairwise outranking accuracy.
- Degree-ordering accuracy.
- Risk-priority assertion accuracy.
- Degree-ablation result.
- Determinism result.
- High-degree-node ordering accuracy.

Ranking must not recompute Graph Retrieval or Planning outputs.

---

## Selection

### Input

- Frozen ranked candidate sequence.
- Work-item budget.
- Token budget.
- Reservation rules.

### Output

- Selected units.
- Omitted units.
- Drop reasons.

### Responsibilities

Selection owns:

- Bounded subset selection.
- Local/interaction reservation behavior.
- Work-item budget enforcement.
- Token budget enforcement.
- Omission attribution.

### Metrics

Report:

- Unconstrained selection recall.
- Constrained selection recall.
- Required local/interaction coverage.
- Work-item budget compliance.
- Token budget compliance.
- Budget-limited omission count.
- Ordinary omission count.

Selection must not:

- Recalculate risk scores.
- Modify graph factors.
- Independently rerank candidates.

---

## End-to-End Evaluation

End-to-end runs remain available to measure propagation effects across:

Graph Retrieval → Planning → Ranking → Selection

For isolated component evaluation, failures are attributed to the first component whose output violates its contract when evaluated against frozen canonical inputs.

---

# Metric Definitions

## Graph scope

Every graph-labeled fixture must declare whether adjacency is exhaustive for the labeled nodes.

For an exhaustively labeled node, all canonical retrieved incident edges within the labeled scope are evaluable.

Define:

- `TP` = expected canonical edges retrieved within labeled scope.
- `FN` = expected canonical edges missing within labeled scope.
- `FP` = retrieved canonical edges within labeled scope that were not expected.

Edges outside labeled scope are ignored for precision calculations.

## Graph retrieval metrics

```text
microEdgeRecall = ΣTP / Σ(TP + FN)

microEdgePrecision = ΣTP / Σ(TP + FP)

adjacencyRecall(node) =
  retrievedExpectedAdjacency(node) /
  expectedAdjacency(node)

macroAdjacencyRecall =
  mean(applicable adjacencyRecall(node))

minimumNodeAdjacencyRecall =
  min(applicable adjacencyRecall(node))
```

## N/A rules

- Unlabeled graph cases are N/A, not zero.
- Zero expected positives produce N/A recall.
- Zero retrieved positives produce N/A precision.
- N/A values are excluded from aggregate denominators.
- Applicable fixture/node counts are always reported.
- Intentionally empty adjacency sets use exact set equality even when recall itself is N/A.

---

# Canonical Graph Factors

For node `n`:

```text
inNeighbors(n) =
  unique source nodes with an eligible canonical directed edge into n

outNeighbors(n) =
  unique target nodes with an eligible canonical directed edge out of n

fanIn(n) =
  |inNeighbors(n)|

fanOut(n) =
  |outNeighbors(n)|

neighborDegree(n) =
  |inNeighbors(n) ∪ outNeighbors(n)|

directedIncidentDegree(n) =
  fanIn(n) + fanOut(n)
```

Use `neighborDegree` as the default structural-connectivity signal for ranking.

Rules:

- Duplicate canonical edges do not increase counts.
- Multiple edge kinds between the same pair count once toward `neighborDegree`.
- Multiple edge kinds may continue to affect existing semantic edge-risk factors.
- Self-edges do not contribute to degree.
- Edge-kind-weighted degree is out of scope.
- Confidence-weighted degree is out of scope.

---

# Degree-Aware Ranking Contract

Use:

```text
totalRisk = semanticRisk + graphDegreeContribution
```

Candidate form:

```text
graphDegreeContribution =
  MAX_DEGREE_BOOST *
  min(
    log1p(neighborDegree) / log1p(DEGREE_CAP),
    1
  )
```

## Required invariants

The degree contribution must be:

- Monotonic.
- Bounded.
- Deterministic.
- Capable of changing ordering when otherwise-identical candidates differ materially in degree.
- Unable by itself to overwhelm protected semantic risk classes.
- Saturated at or above the configured degree cap.

## Protected semantic signals

At minimum, degree alone must not dominate clearly stronger risk signals such as:

- Authentication/security boundaries.
- Critical producer-consumer contract changes.
- Schema/configuration compatibility changes.
- Critical lifecycle/concurrency interactions.
- Explicit public/API compatibility changes.

## Calibration requirement

Do not commit arbitrary degree constants without validating them against the existing semantic-risk score distribution.

Required constraint:

```text
0 < MAX_DEGREE_BOOST < minimum protected semantic-risk separation
```

`DEGREE_CAP` should be chosen from representative repository graph-degree distributions and should saturate before common utility hubs can dominate ranking solely from connectivity.

Initial candidate values may be tested:

```text
MAX_DEGREE_BOOST = 20
DEGREE_CAP = 16
```

These values are not contractual until calibration tests demonstrate that:

- degree can affect otherwise-comparable ordering;
- protected semantic risk still outranks degree alone;
- common high-degree hubs do not dominate broadly.

The final chosen values must be recorded in eval output and baseline metadata.

---

# Ranking Evaluation Contract

Prefer explicit pairwise assertions for component-level ranking tests.

Fixtures may declare:

```text
mustOutrank:
  - [higherRiskWorkItemId, lowerRiskWorkItemId]
```

Report:

```text
riskMustOutrankAccuracy =
  satisfiedMustOutrankAssertions /
  applicableMustOutrankAssertions
```

Complete expected ordering may also be reported where useful, but pairwise assertions are the primary correctness oracle.

## Required ranking fixtures

### Degree isolation

All non-degree factors must be exactly equal.

```text
semanticRisk(A) == semanticRisk(B)
degree(A) > degree(B)
```

Expected:

```text
A outranks B
```

### Degree ablation

Given identical candidates:

1. Equalize or disable degree contribution.
2. Record the baseline ordering.
3. Restore the intended degree difference.
4. Verify the ordering changes as specified.

This proves degree caused the ranking change.

### Semantic override

A generic high-degree hub competes with a lower-degree candidate containing a protected semantic risk.

Expected:

```text
protected semantic risk outranks generic hub
```

### Determinism

Repeated ranking of byte-identical inputs must produce:

- identical scores;
- identical ordered IDs;
- identical tie-breaking.

---

# Ranking-to-Selection Boundary

Ranking owns ordering.

Selection may deviate from simple rank order only because of documented constraints:

- Local/interaction reservation.
- Hard work-item limit.
- Hard token limit.

Every selected or omitted work item must retain:

- Incoming rank.
- Risk factors.
- Risk score.
- Estimated token cost.
- Selection/drop reason.

This must make it possible to distinguish:

- wrong ordering from Ranking;
- correct ordering but incorrect constrained subset from Selection.

---

# Constrained Selection Oracle

Define:

```text
expectedEligible =
  all expected eligible work items before budget constraints

expectedFeasible =
  expected work items that should survive the declared
  reservation and budget policy

requiredReserved =
  work items or work-item kinds the selection contract requires preserving
```

Use:

- `selectionExpectedRecall` for unconstrained expected coverage where applicable.
- `selectionConstrainedRunRecall` with `expectedFeasible` as the denominator.

A work item that cannot fit under the declared hard budget must not count as an ordinary selection miss if it is correctly classified as a budget-limited omission.

Budget-limited omissions must be reported separately.

---

# Baseline and Schema Compatibility Contract

Splitting the previous combined Planning / Ranking / Selection component is an evaluation-schema change.

The existing baseline must remain immutable.

After the split:

- Unchanged end-to-end metrics may be compared directly when definitions are unchanged.
- New Planning metrics are non-comparable unless historical values can be reconstructed with identical semantics.
- New Ranking metrics are non-comparable unless historical values can be reconstructed with identical semantics.
- New Selection metrics are comparable only if their formulas and denominators are definitionally identical.
- The removed combined-stage metric must not be numerically compared against any one of the new components.

Reports must identify:

- Evaluation schema version.
- Metric definition/version where required.
- Baseline schema version.
- Directly comparable metrics.
- New metrics.
- Redefined metrics.
- Non-comparable metrics.

A replacement baseline may be created only after the new schema and implementation pass all correctness gates.

---

# Execution Plan

## Evaluation applicability, resolution, and status contract

Stage scope, runtime completion, and oracle correctness are separate axes.

- A stage omitted from a fixture is `not-applicable` (`N/A`). It is excluded
  from stage/case status and all aggregate denominators.
- `not-evaluable` is reserved for a declared stage contract that could not run.
- `executionStatus` records runtime completion only.
- `candidateResolution` is `proven`, `disproven`, `unproven`, or `missed`.
- `evalStatus` is `pass`, `fail`, or `partial`: a definitive wrong result or
  missed expected candidate is `fail`; a candidate that entered the pipeline
  but could not reach its required terminal disposition is `partial`.

Definitive oracle failure has precedence over an unrelated unproven candidate.
A valid verifier abstention after all scheduled work completes does not make
execution partial. Reports must retain the expected disposition,
`oracleSatisfied`, and a typed root-cause code. Candidate recall, verified
recall, and final finding recall are independent metrics.

ReviewResult schema v4 carries typed candidate-resolution audit data. Eval and
baseline schema v3 carry the split status fields and resolution metrics. Older
runtime results are adapted conservatively and older baseline artifacts remain
immutable. Baseline creation is observational; promotion is a separate,
metric-gated decision.

## Phase 0 — Characterize Current Behavior

### Goal

Capture current behavior before modifying evaluation or ranking semantics.

### Tasks

Record current:

- Graph metric outputs.
- Combined Planning/Ranking/Selection metrics.
- Candidate work items for targeted fixtures.
- Risk-factor values.
- Risk scores.
- Ranking order.
- Selected work items.
- Drop reasons where available.
- Finding recall.
- Precision.
- Verified precision.
- Token usage.
- Model-call count.
- Latency.
- Partial-review rate.

### Rules

- These are characterization artifacts only.
- Do not create a new baseline.
- Do not modify the existing baseline.
- Do not convert characterization values into new acceptance thresholds without explicit justification.

### Exit criteria

- Characterization artifacts are recorded.
- Existing tests pass.
- No production behavior has changed.

### Forbidden changes

- No graph metric changes.
- No ranking changes.
- No selection changes.
- No baseline creation.

---

## Phase 1 — Graph Evaluation Contract and Metrics

### Preconditions

- Phase 0 complete.
- Existing graph behavior characterized.

### Tasks

1. Add/extend fixture schema for exhaustive graph scope.
2. Add expected canonical adjacency.
3. Implement micro edge recall.
4. Implement micro edge precision.
5. Implement per-node adjacency recall.
6. Implement macro adjacency recall.
7. Implement minimum node adjacency recall.
8. Implement exact fan-in/fan-out/degree correctness.
9. Implement missing/unexpected edge counts.
10. Implement N/A and denominator rules.
11. Add high-degree graph fixture.

### Required tests

- Complete adjacency.
- Missing neighbors.
- Extra edges.
- Multiple edge kinds.
- Duplicate edges.
- Self-edges.
- Fan-in.
- Fan-out.
- High-degree nodes.
- Intentionally empty adjacency.
- Unlabeled graph case.
- Cross-case aggregation.
- Zero-denominator behavior.

### Exit criteria

- All focused graph evaluator tests pass.
- Existing graph behavior outside the new metrics remains unchanged.
- Relevant integration tests pass.

### Forbidden changes

- No degree-aware ranking.
- No selection behavior changes.
- No baseline creation.

---

## Phase 2 — Split Planning, Ranking, and Selection Eval Components

### Preconditions

- Phase 1 complete.
- Graph metric contracts pass.

### Tasks

1. Introduce separate Planning stage definition.
2. Introduce separate Ranking stage definition.
3. Introduce separate Selection stage definition.
4. Add frozen component inputs to fixtures/evaluator harness.
5. Preserve end-to-end evaluation.
6. Implement first-failing-component attribution.
7. Move existing metrics to the correct stage without silently changing definitions.
8. Mark redefined metrics as new/non-comparable.

### Required tests

- Planning can run from frozen graph input.
- Ranking can run from frozen work items/risk factors.
- Selection can run from frozen ranked input.
- Upstream failure does not create downstream component failure in isolated mode.
- End-to-end propagation still captures downstream effects.
- Existing selection metrics preserve semantics where intended.
- Schema-version behavior is correct.

### Exit criteria

- All three stages execute independently.
- Existing end-to-end evaluation still works.
- Failure attribution tests pass.
- No degree ranking behavior has changed.

### Forbidden changes

- No degree contribution to ranking.
- No new baseline.
- Do not remove historical comparison artifacts.

---

## Phase 3 — Canonical Graph Factors in Planning

### Preconditions

- Phase 1 graph canonicalization tests pass.
- Phase 2 Planning schema exists.
- Ranking behavior remains unchanged.

### Tasks

1. Implement/expose `fanIn`.
2. Implement/expose `fanOut`.
3. Implement/expose `neighborDegree`.
4. Implement/expose `directedIncidentDegree`.
5. Add exact value correctness metrics.
6. Add availability-versus-correctness metrics.
7. Ensure graph factors are retained in work-item diagnostics.

### Required tests

- Exact fan-in.
- Exact fan-out.
- Exact neighbor degree.
- Exact directed incident degree.
- Duplicate-edge deduplication.
- Multiple-edge-kind deduplication for adjacency.
- Self-edge exclusion.
- Wrong-but-present value counts as available but incorrect.
- Missing value counts as unavailable.

### Exit criteria

- Exact graph-factor tests pass.
- Existing ranking snapshots/order remain unchanged.
- Relevant package and integration tests pass.

### Forbidden changes

- Do not modify ranking weights.
- Do not modify Selection.
- Do not create a baseline.

---

## Phase 4 — Degree-Aware Ranking

### Preconditions

- Phase 3 exact graph-factor tests pass.
- Frozen Ranking inputs exist.
- Existing semantic-risk score distribution has been characterized.

### Tasks

1. Implement bounded/logarithmic degree contribution.
2. Calibrate `MAX_DEGREE_BOOST`.
3. Calibrate `DEGREE_CAP`.
4. Add degree contribution to diagnostics.
5. Preserve deterministic tie-breaking.
6. Preserve protected semantic-risk dominance.
7. Add pairwise ranking assertions.

### Required tests

- Degree isolation.
- Degree ablation.
- Semantic override.
- Degree cap saturation.
- Monotonic degree contribution.
- Deterministic score/order.
- High-degree versus low-degree ordering.
- Critical semantic signal versus generic high-degree hub.

### Exit criteria

- Degree demonstrably changes otherwise-equal ranking.
- Protected semantic risks still outrank degree alone.
- Chosen constants pass calibration tests.
- Ranking remains deterministic.
- No budget or Selection semantics change.

### Forbidden changes

- Do not weaken semantic risk signals to make degree visible.
- Do not modify Selection to compensate for Ranking.
- Do not create a baseline.

---

## Phase 5 — Selection Boundary and Attribution

### Preconditions

- Phase 4 ranking tests pass.
- Ranking emits stable ordered candidates and diagnostics.

### Tasks

1. Enforce Ranking-to-Selection immutability.
2. Preserve incoming rank/risk metadata.
3. Implement/verify constrained-selection oracle.
4. Distinguish budget-limited omissions from ordinary omissions.
5. Preserve local/interaction reservation behavior.
6. Verify hard budgets remain unchanged.

### Required tests

- Ranking-to-selection immutability.
- Hard work-item budget.
- Hard token budget.
- Local reservation.
- Interaction reservation.
- Constrained-selection oracle.
- Correct omission classification.
- Correct drop reasons.
- First-failing-component attribution.

### Exit criteria

- Selection never recomputes risk.
- Selection never silently reranks.
- Hard budgets remain hard.
- Omission reasons are attributable.

### Forbidden changes

- No ranking-score changes.
- No graph-factor changes.
- No baseline creation.

---

## Phase 6 — Reporting and Schema Migration

### Preconditions

- Phases 1–5 pass.
- New component schema is stable.

### Tasks

1. Add evaluation schema version.
2. Add metric definition/version where needed.
3. Separate Graph Retrieval, Planning, Ranking, and Selection report sections.
4. Add comparability metadata.
5. Preserve old baseline artifact.
6. Mark new/redefined metrics non-comparable.
7. Preserve existing raw-data removal from HTML reports.

### Required tests

- JSON report schema.
- HTML report sections.
- Metric comparability labeling.
- Baseline schema version display.
- Non-comparable metric handling.
- Historical baseline immutability.
- Raw-data exclusion.

### Exit criteria

- Reports clearly distinguish all four components.
- Comparable vs non-comparable metrics are explicit.
- Old baseline remains intact.

### Forbidden changes

- No baseline replacement yet.
- No hidden remapping of old combined metrics onto new stage metrics.

---

## Phase 7 — Full Evaluation and Regression Gate

### Preconditions

- Phases 1–6 pass.
- Full implementation is complete.
- No replacement baseline exists yet.

### Required gates

Run sequentially:

1. Focused evaluator and ranking tests.
2. Engine/integration tests.
3. Full test suite.
4. Typecheck.
5. Build.
6. Lint.
7. MatrixCore changed-workspace quality gate.
8. Adversarial review.

### Adversarial review focus

Review specifically for:

- Component isolation violations.
- Degree dominance.
- Degree contribution too weak to matter.
- Duplicate-edge inflation.
- Incorrect N/A aggregation.
- Budget bypass.
- Accidental Selection reranking.
- Wrong omission attribution.
- Invalid baseline comparability.
- Tests that accidentally validate implementation rather than contract.

### Eval run

Run the component/small suite without baseline creation.

Inspect:

- Graph Retrieval metrics.
- Planning metrics.
- Ranking metrics.
- Selection metrics.
- End-to-end propagation.
- Selection recall.
- Finding recall.
- Precision.
- Verified precision.
- Token usage.
- Model-call count.
- Latency.
- Partial-review rate.
- Budget omissions.
- Fixture-level regressions.

Compare only unchanged metric definitions against the historical baseline.

New or redefined metrics remain non-comparable.

### Exit criteria

- All required gates pass.
- Degree-aware ranking demonstrates the intended structural-risk improvement.
- No unacceptable regression in finding quality, cost, latency, or budget behavior.
- Report comparability is correct.
- No baseline has yet been replaced.

---

## Phase 8 — Replacement Observational Baseline

### Preconditions

- Phase 7 complete.
- Evaluation run is baseline-eligible.
- No unresolved correctness or architectural failures remain.

### Tasks

1. Create the replacement observational baseline.
2. Regenerate JSON report.
3. Regenerate HTML report.
4. Verify separate component sections.
5. Verify comparability metadata.
6. Run MatrixCore completion gate.
7. Record a clean checkpoint with final metrics and schema version.

### Exit criteria

- Replacement baseline exists.
- Historical baseline remains preserved.
- Reports match the replacement baseline.
- Completion gate passes.
- Baseline creation is recorded as observational only.

---

# Orchestrator Execution Policy

The orchestrator owns this entire document and is responsible for preserving the Global Invariants across all delegated work.

## Delegation model

Do not give every sub-agent the entire implementation problem.

For each phase, provide the assigned agent with:

1. Phase goal.
2. Relevant Global Invariants.
3. Preconditions.
4. Exact tasks.
5. Relevant files/modules.
6. Required tests.
7. Exit criteria.
8. Forbidden changes.
9. Required handoff output.

The master plan remains the authoritative source of truth.

Sub-agent prompts are execution slices, not alternate specifications.

## Phase ordering

Do not run dependency-coupled phases in parallel.

Required dependency chain:

```text
Phase 0
  ↓
Phase 1
  ↓
Phase 2
  ↓
Phase 3
  ↓
Phase 4
  ↓
Phase 5
  ↓
Phase 6
  ↓
Phase 7
  ↓
Phase 8
```

Parallelism is permitted only within a phase when tasks are genuinely independent and merge conflicts/semantic overlap are controlled.

Prefer sequential roles for high-risk behavioral phases:

```text
Implementer
  ↓
Deterministic test/review agent
  ↓
Adversarial reviewer
  ↓
Orchestrator gate
```

## Repair policy

If a phase exit gate fails:

1. Diagnose the failing invariant, test, or contract.
2. Delegate a targeted repair.
3. Rerun the phase gate.

After three unsuccessful repair cycles, stop progression and escalate the failure to the orchestrator.

Do not:

- Weaken a valid test.
- Relax a valid oracle.
- Change the architectural contract to make the implementation pass.
- Proceed to a later phase with unresolved failures.

---

# Sub-Agent Handoff Contract

Every implementation/review agent must return:

## Summary

- What changed.
- Why it changed.

## Files changed

- Exact files/modules modified.

## Tests

- Tests added.
- Tests updated.
- Tests run.
- Results.

## Contract verification

Explicitly state whether each relevant Global Invariant remains satisfied.

## Risks / unresolved issues

List any:

- Failing tests.
- Ambiguous semantics.
- Unexpected coupling.
- Regression.
- Deferred concern.

## Forbidden-change verification

Explicitly confirm that forbidden changes for the assigned phase were not made.

The orchestrator must review this handoff before advancing.

---

# Final Completion Gate

The migration is complete only when all of the following are true:

- Graph Retrieval metrics are scoped and correct.
- Planning uses frozen graph inputs in isolated evaluation.
- Ranking uses frozen risk-factor inputs in isolated evaluation.
- Selection uses frozen ranked inputs in isolated evaluation.
- Canonical degree semantics are deterministic and deduplicated.
- Degree contributes meaningfully to ranking.
- Degree contribution is bounded.
- Protected semantic risks still dominate degree alone.
- Selection does not recompute or rerank risk.
- Work-item and token budgets remain hard.
- Budget-limited omissions are distinguishable from ordinary misses.
- Failure attribution works by component.
- Reports separate Graph Retrieval, Planning, Ranking, and Selection.
- Historical baseline comparability is explicit.
- Old baseline remains immutable.
- Full tests, typecheck, build, lint, quality gate, and adversarial review pass.
- Component/small eval passes without unacceptable regression.
- Replacement observational baseline is created only after all prior gates pass.
- MatrixCore completion gate passes.

---

# Assumptions

- The historical baseline remains available as a comparison artifact.
- The removed combined-stage metric is not compared numerically with any single new component metric.
- Degree is a Planning-derived risk factor and a Ranking input, not a Graph Retrieval quality score.
- Existing hard work-item and token budgets remain unchanged.
- Existing local/interaction reservation behavior remains unchanged unless a failing correctness test proves the current behavior violates its existing contract.
- Existing raw-data removal from HTML reports remains in effect.

---

# Four-Case Repair Campaign (Evaluation Schema v4)

This section is normative for the repair campaign prompted by the first
component-small v3 report. It refines the earlier execution plan without
changing hard work-item, token, context-expansion, or degree-ranking limits.

## Evaluation scope and execution

Eval case schema v9 adds an ordered, duplicate-free
`evaluationScope.stages` declaration. A listed stage must have its matching
expectation block, and an expectation block must be listed. Candidate and
downstream ground-truth fields, including `exhaustiveCandidates`, are valid
only when the relevant stages are in scope.

Stages omitted from a fixture are `N/A`: they are excluded from case status
and aggregate denominators and are not executed. If the highest declared stage
is Snapshot, Graph Retrieval, Planning, Ranking, Selection, or Projection, the
eval harness performs deterministic preparation only, reports zero model
calls, and does not manufacture a production `ReviewResult`. Production review
execution retains strict `PARTIAL != PASS` semantics.

The evaluator distinguishes the repository-wide source projection from the
candidate-visible projection assembled from selected work items. Selection
recall is computed over the union of selected candidate contexts. Candidate
context coverage and `context-assembly-miss` are reported separately. An
unrelated failed or partial candidate must not relabel a missing gold finding
as a budget failure.

Eval report/baseline schema v4 records case schema v9, stage applicability,
source and candidate projection provenance, candidate-context coverage,
metric-definition versions, and v3 comparability metadata. Historical v3
baselines remain immutable.

## Repair 1 — Fantasy structural scope and truthful companion

1. Validate that every fixture unified diff reconstructs its frozen postimage.
2. Preserve hunk ranges for context but derive exact added/replaced line ranges
   for candidate anchoring.
3. Restrict relational evidence to directionally valid graph edges; no broad
   path-search fallback may call a definition its own caller or callee.
4. Reject expression-shaped symbol locators instead of reducing them to a
   generic identifier, and expose literal locator mode in provider schemas.
5. Make citation repair a constrained selection of allowed evidence IDs for
   missing request groups. It may add only IDs explicitly selected by the
   model, and may not alter verdict, confidence, or reasoning. Failed repair
   remains partial.
6. Scope `fantasybotcrawler-player-identity-edges` through Projection only.
   Add a separate end-to-end companion with a stable external player ID,
   display-only Unknown fallback, and a frozen distinct-ID test.

Promotion requires three deterministic structural passes and three consecutive
live companion passes, with exact fixture integrity and no citation-validation
failure.

## Repair 2 — Budgeting table source label

Construct one local work item per canonical changed symbol. A work item owns
all changed regions of that symbol and packs them deterministically; it is not
split into one task per hunk merely because the symbol exceeds a per-snippet
budget. Interaction work items include all changed primary regions plus the
minimum related contract context. Selection consumes incoming Ranking order
after documented local/interaction reservation and does not apply novelty
reranking.

Evidence packing is request-group fair: compact records around the actual
match, then give each request group one fitting record before adding additional
records. The source-label fixture receives explicit frozen Ranking and
Selection inputs/oracles. Promotion requires three consecutive live passes
with complete candidate-context, evidence, verification, and final-finding
coverage.

## Repair 3 — Budgeting component layout

Apply the same multi-region work-item and frozen component contracts. The
candidate-visible context must contain the changed layout location even when
the component has other changed regions. Optional contribution/stub context
remains optional. Any model-facing guidance must describe a general structural
layout invariant and must not contain fixture literals. Promotion requires
three consecutive live passes.

## Repair 4 — Noisy producer/type/consumer chain

Planning may construct bounded multi-edge interaction clusters when canonical
edges share a changed endpoint and jointly describe one risk family. The
cluster replaces redundant single-edge tasks for that family, carries all
contributing edges, and uses the maximum semantic edge risk rather than a sum.
The invoice cluster must expose producer, changed type, and consumer in one
candidate-visible task. Ranking and Selection receive explicit frozen oracles;
telemetry context is forbidden from the selected candidate projection.

Any model-facing unit-flow or severity guidance must be general: trace values
from producer through declared type to consumer units, and treat
order-of-magnitude financial corruption as critical. Fixture-specific names,
paths, constants, and expected prose are forbidden. Promotion requires three
consecutive live passes.

## Campaign completion gate

Each repair is sequential and has at most three autonomous repair attempts.
For every repair run focused unit/integration tests, eval schema validation,
build/typecheck, lint, isolated evaluation, three required live repetitions,
and independent adversarial review. After all four pass, run the full test
suite and component-small suite, then create observational artifacts:

```text
.quality/evals/component-small-v4.json
.quality/evals/component-small-v4.html
evals/agentsmith/baselines/component-small-v4.json
```

The HTML must be generated from the same JSON result and must not contain a raw
data section. Baseline creation remains observational; promotion is a separate
deterministic decision.
