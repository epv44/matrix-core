# Small-Model Review Migration Roadmap

## Purpose

This roadmap migrates the small-model review path toward a deterministic, eval-driven architecture that improves review quality primarily through:

1. better code/context selection;
2. bounded review tasks;
3. focused specialist lenses;
4. bounded context expansion;
5. evidence-based verification;
6. deterministic aggregation and routing.

The central architectural assumption is:

> Small-model review quality depends first on selecting the right changed code and the minimum supporting context needed to establish a defect. Prompt narrowing cannot recover evidence that was never selected.

The migration therefore prioritizes **selection recall and context construction before prompt micro-optimization**.

## Target Architecture

```text
Frozen repository snapshot
        │
        ▼
Changed-symbol + interaction-unit generation
        │
        ▼
Risk ranking + HARD work budget
        │
        ├── local changed-symbol units
        └── cross-file / interaction units
        │
        ▼
Bounded ReviewTask descriptor
        │
        ├── code/context
        ├── selection rationale
        ├── review lens
        ├── allowed context expansion
        └── strict output schema
        │
        ▼
Small-model candidate review
        │
        ├── correctness always
        └── targeted specialist lens where applicable
        │
        ▼
Candidate verifier
        │
        ▼
Deterministic aggregation
        │
        ├── verified findings
        ├── unresolved / insufficient-context
        └── partial coverage metadata
        │
        ▼
Optional frontier escalation
```

## Evaluation Principles

The migration must distinguish four failure classes:

1. **Selection miss** — no selected task contained enough evidence to establish the expected finding.
2. **Model miss** — the selected task contained sufficient evidence, but the candidate reviewer failed to identify the finding.
3. **Verification rejection** — the candidate reviewer found the issue, but the verifier rejected it.
4. **Coverage / budget failure** — review could not fully execute because of work-item, token, timeout, or context-expansion limits.

This distinction is mandatory because improving one stage can otherwise mask a regression in another.

## Core Metrics

At minimum:

```text
selection_recall
finding_recall
precision
verified_precision
token_usage
model_call_count
latency
partial_review_rate
```

Additional stage-specific metrics:

```text
cross_file_selection_recall
cross_file_finding_recall
lens_specific_recall
context_expansion_rate
verifier_rejection_rate
```

## Default Promotion Threshold Philosophy

Exact values should ultimately live in machine-readable configuration and be enforced by code.

Initial guidance:

```text
selection_recall:
    maximum regression: 1 percentage point

finding_recall:
    maximum regression: 2 percentage points

precision:
    maximum regression: 2 percentage points

token_usage:
    maximum increase: 15%

repair attempts:
    maximum: 3
```

These are default tolerances, not permission to accept regressions blindly.

Stages explicitly intended to improve a metric must show a measurable improvement in that metric before promotion.

Do not establish arbitrary absolute targets before Stage 1 produces a trustworthy baseline.

---

# Stage 1 — Eval Fixtures + Baseline

## Objective

Create the control group that every subsequent architecture change will be measured against.

## Required Work

Create a small-model review eval corpus containing representative examples of:

- obvious local correctness bugs;
- bugs requiring one caller or callee;
- changed API/contract bugs;
- lifecycle/threading defects;
- benign suspicious patterns that should not be findings;
- interaction bugs involving multiple symbols/files;
- security-sensitive cases;
- large/noisy changes where the full change cannot fit inside the small-model work budget.

Each fixture should record:

```text
expected finding
changed location
minimum evidence required
expected severity/domain
whether small-model discovery is expected
```

Add evaluation support for selection recall, finding recall, precision, token usage, model-call count, latency, and partial review. Persist the baseline.

### Critical Metric: Selection Recall

For every gold finding:

> Did at least one selected work item contain the changed location and enough evidence to establish the finding?

This must be measured independently from model performance.

## Required Tests

- fixture loading;
- deterministic fixture identity;
- metric calculation;
- selection-recall calculation;
- baseline serialization;
- malformed fixture handling.

## Promotion Gate

```text
✓ existing tests pass
✓ eval corpus runs reproducibly
✓ baseline persisted
✓ selection_recall measurable
✓ finding_recall measurable
✓ precision measurable
✓ cost/latency metrics captured
```

No quality improvement is required in Stage 1.

---

# Stage 2 — ReviewUnit / ReviewTask / Result Contracts

## Objective

Make every small-model invocation typed, bounded, reproducible, and deterministically validated.

## Suggested Contracts

```ts
interface ReviewUnit {
  id: string;
  kind: "local" | "interaction";
  changedSymbols: SymbolRef[];
  changedRanges: SourceRange[];
  context: ContextRef[];
  riskScore: number;
  riskReasons: RiskReason[];
  estimatedTokens: number;
}
```

```ts
interface ReviewTask {
  unit: ReviewUnit;
  lens: ReviewLens;
  snapshotId: string;
  tokenBudget: number;
  expansionBudget: number;
  outputContractVersion: string;
}
```

Candidate output should support:

```text
findings[]
context_requests[]
status:
    complete
    insufficient_context
```

Every finding should contain bounded structured evidence such as file, line/range, title, impact, evidence, confidence, and category.

## Required Deterministic Validation

Reject nonexistent files, invalid source locations, malformed findings, invalid enum values, missing evidence, prohibited out-of-scope references, and invented symbols when symbol resolution is required.

## Required Tests

- contract serialization;
- deterministic IDs where applicable;
- malformed output;
- invalid paths;
- invalid line ranges;
- missing evidence;
- insufficient-context output;
- backwards-compatibility behavior.

## Promotion Gate

```text
✓ old tests pass
✓ new schema tests pass
✓ malformed model output cannot surface
✓ task serialization is reproducible
✓ eval quality does not materially regress
```

Stage 2 is expected to be mostly behavior-neutral.

---

# Stage 3 — Changed-Symbol Review Units

## Objective

Replace arbitrary diff/snippet review with symbol-centered review units.

## Required Work

For every materially changed symbol, construct a local review unit containing:

```text
changed symbol
+ containing declaration
+ changed hunks
+ immediately necessary local context
```

Avoid ranking arbitrary snippets independently when they belong to the same semantic unit.

## Required Tests

- symbol extraction;
- changed-symbol mapping;
- hunk-to-symbol association;
- local context inclusion;
- token estimation;
- deterministic unit construction;
- unsupported-language fallback behavior.

## Promotion Gate

```text
✓ tests pass
✓ changed symbols map to expected ReviewUnits
✓ no uncontrolled scope widening
✓ token accounting correct
✓ selection_recall >= allowed baseline threshold
```

Preferred outcome: selection recall begins improving without increasing work budget.

---

# Stage 4 — Interaction Units + Risk Scoring + Hard Selection

## Objective

Improve selection recall for bugs whose evidence crosses symbol or file boundaries.

## Required Interaction Types

Where graph data supports them, consider:

```text
changed function → caller
changed function → callee
changed interface → implementation
schema → consumer
config → consumer
changed type → user
changed producer → consumer
changed symbol → changed symbol
```

## Risk Signals

Risk scoring may include deterministic signals such as:

```text
public/API surface change
return/error/nullability change
high fan-in
high fan-out
schema/config change
auth/security boundary
filesystem/network/database I/O
threading/async/lifecycle change
dependency change
large control-flow rewrite
multi-file interaction
```

Risk scoring is for **ranking**, not deterministic diagnosis.

## Hard Budgets

The selector must enforce both:

```text
max work items
AND
max projected review tokens
```

The limits must be actual execution constraints, not ranking hints.

Where meaningful interaction risk exists, preserve interaction coverage so local units cannot consume the entire budget. An initial heuristic may reserve approximately:

```text
up to 3 highest-risk local units
+
1 highest-risk interaction unit
```

This is an initial heuristic only; later evals may tune it.

## Required Tests

- graph-edge unit construction;
- risk signal computation;
- deterministic ranking;
- deterministic tie breaking;
- work-item budget enforcement;
- token budget enforcement;
- local-only changes;
- cross-file changes;
- interaction reservation behavior.

## Promotion Gate

```text
✓ hard work-item budget enforced
✓ hard token budget enforced
✓ deterministic ranking
✓ local fixture coverage retained
✓ cross-file selection recall improves
✓ overall selection recall improves or stays within strict tolerance
✓ finding recall remains within allowed tolerance
✓ token/latency cost remains acceptable
```

This stage should show a measurable improvement in cross-file selection recall.

Forbidden shortcuts:

- increasing the work-item limit simply to increase recall;
- increasing context limits simply to increase recall;
- fixture-specific ranking rules.

---

# Stage 5 — Selection Audit + Coverage Reporting

## Objective

Make every selection decision diagnosable.

## Required Trace Data

For every candidate unit:

```text
selected/dropped
risk score
risk reasons
estimated tokens
ranking position
budget state
drop reason
interaction/local classification
```

The eval/reporting layer should be able to classify missed gold findings as selection miss, model miss, verifier rejection, or budget/partial failure.

## Required Tests

- selected-unit audit;
- dropped-unit audit;
- budget exhaustion trace;
- deterministic audit output;
- failure-classification logic.

## Promotion Gate

```text
✓ every selected unit explains why it was selected
✓ every dropped unit explains why it was dropped
✓ budget exhaustion is visible
✓ eval distinguishes selection vs model vs verifier misses
✓ review quality does not materially regress
```

Stage 5 is primarily observability/infrastructure.

---

# Stage 6 — Review Lens Registry

## Objective

Preserve specialized reviewer expertise while making small-model prompts bounded and focused.

## Initial Lenses

```text
correctness
performance-threading
contract-semantic
security
```

## Routing Policy

Every selected unit receives `correctness`.

Risk signals may add at most one additional specialist lens in the initial implementation.

Examples:

```text
threading/async risk   → performance-threading
API/schema risk        → contract-semantic
security boundary      → security
```

Avoid multiplying every work unit by a large matrix of micro-review passes.

## Large-Model Compatibility

Preserve broad specialist reviewer behavior for the large/frontier path:

```text
small model:
    bounded unit × focused lens

large model:
    broad/full projection × broad specialist lens
```

## Required Tests

- correctness always present;
- deterministic specialist routing;
- max lens/call limits;
- no accidental duplicate lenses;
- specialist prompt/task construction;
- specialist fixture behavior.

## Required Eval Comparisons

Where feasible compare old broad specialist behavior vs bounded specialist lens behavior.

## Promotion Gate

```text
✓ correctness lens always applied
✓ specialist routing deterministic
✓ max model-call budget respected
✓ specialist fixture performance retained or improved
✓ false-positive rate does not materially worsen
```

Do not delete existing specialist knowledge merely because the small-model path changes how it is applied.

---

# Stage 7 — Bounded Context Expansion

## Objective

Allow the model to request missing evidence without giving it uncontrolled repository browsing.

## Context Request Contract

Example:

```json
{
  "context_requests": [
    {
      "kind": "callers",
      "symbol": "fetchUser",
      "reason": "Need to establish the nullability contract"
    }
  ]
}
```

## Engine Responsibility

The deterministic engine resolves supported requests through mechanisms such as symbol definition, caller, callee, implementation, schema, configuration, or graph edge.

The model must not independently search or browse the repository.

## Initial Expansion Limits

Enforce bounds such as:

```text
maximum one expansion round
maximum N references
maximum X additional tokens
```

Exact values should be chosen from eval evidence.

If sufficient evidence still cannot be established:

```text
status = insufficient_context
```

Do not convert uncertainty into a guessed finding.

## Required Tests

- typed request parsing;
- allowed request kinds;
- invalid request rejection;
- reference-count limit;
- token limit;
- expansion-round limit;
- no direct repo browsing;
- insufficient-context fallback.

## Promotion Gate

```text
✓ model cannot directly widen repository scope
✓ requests flow only through typed context APIs
✓ expansion bounds are hard limits
✓ invalid requests are rejected
✓ cross-file finding recall improves
✓ token/call increase remains within configured threshold
```

This stage should produce a measurable improvement on fixtures that require external evidence.

---

# Stage 8 — Candidate Verification + Deterministic Aggregation

## Objective

Prevent unsupported candidate findings from becoming user-visible results.

## Verification Input

For each candidate provide:

```text
candidate claim
+ cited code
+ minimum relevant supporting context
```

The verifier should attempt to **disprove** the finding rather than merely restating it.

## Verification Result

```text
confirmed
rejected
insufficient_context
```

## Deterministic Evidence Checks

Validate that the cited file/location exists, evidence belongs to the frozen snapshot, the finding refers to relevant changed behavior, and required evidence references resolve.

Security review may retain stronger reachability/impact/defense verification rules.

## Anti-Pattern

Do not run the same small model twice with slightly different wording and treat agreement as proof. Correlated agreement is not a sufficiently strong verifier.

## Required Tests

- valid candidate survives;
- unsupported candidate rejected;
- hallucinated path rejected;
- invalid line rejected;
- frozen snapshot enforced;
- verifier cannot rewrite unsupported evidence;
- insufficient-context behavior;
- deterministic aggregation.

## Promotion Gate

```text
✓ unsupported candidates are rejected
✓ valid candidates survive at acceptable recall
✓ hallucinated evidence is rejected
✓ frozen snapshot evidence enforced
✓ verified_precision improves
✓ verified finding recall does not collapse
```

Improving precision by simply deleting findings is not acceptable.

---

# Stage 9 — Routing + Escalation + Shadow Comparison

## Objective

Integrate the new small-model path into deterministic routing and compare it against the existing implementation before replacement.

## Routing

Preserve a holistic route when the change fits comfortably within the configured model context:

```text
FULL
    → holistic/broad review

PARTITIONED
    → Stage 3–8 small-model pipeline
```

A threshold around a fraction of usable context may be retained initially and tuned by eval.

## Escalation Signals

Where a larger model is configured, escalation may be triggered by:

```text
high-risk unit dropped because of budget
high-risk insufficient_context
large API/schema migration
multiple interaction units exceed budget
architecture-level reasoning required
small-model timeout
partial execution
```

## Mandatory Semantics

```text
PARTIAL != PASS
TIMEOUT != PASS
INSUFFICIENT_CONTEXT != PASS
BUDGET_EXHAUSTED != PASS
```

## Shadow Mode

Before deleting the old implementation, run:

```text
OLD small-model path
        │
        ├── comparison report
        │
NEW small-model path
```

Compare selection recall, finding recall, precision, verified precision, token usage, calls, latency, partial rate, and fixture-by-fixture differences.

## Required Tests

- full-context routing;
- partitioned routing;
- threshold boundary behavior;
- escalation signal behavior;
- partial semantics;
- shadow report generation;
- end-to-end regression.

## Promotion Gate

```text
✓ full route behaves as intended
✓ partitioned route deterministic
✓ PARTIAL never becomes PASS
✓ escalation signals tested
✓ shadow comparison generated
✓ new path meets configured quality/cost criteria
✓ end-to-end regression suite passes
```

Only after this stage passes should removal of the previous path be considered.

---

# Implementation / PR Sequence

| Stage | Deliverable |
|---|---|
| 1 | Eval fixtures + baseline + selection recall |
| 2 | ReviewUnit / ReviewTask / result contracts |
| 3 | Changed-symbol unit generation |
| 4 | Interaction units + risk scoring + hard selector |
| 5 | Selection audit + coverage/failure classification |
| 6 | Review lens registry + specialist migration |
| 7 | Bounded context request/resolution loop |
| 8 | Candidate verifier + deterministic aggregation |
| 9 | Router + escalation + shadow comparison |

Keep each stage independently reviewable and revertible.

## Explicitly Deferred Optimizations

Do not prioritize these before the nine stages above are working:

- descriptor SHA-256 sealing as a review-quality mechanism;
- large micro-pass registries;
- dozens of binary YES/NO prompts;
- aggressive concurrency;
- same-model duplicate-review agreement;
- model routing based only on parameter count;
- deleting broad specialist prompts from the frontier path.

Descriptor hashes may still be useful later for trace identity, cache keys, stale-result detection, reproducibility, and auditability, but they are not a substitute for correct context selection and evidence.

## Completion Definition

The migration is successful when:

> A small model receives only a few deliberately selected review units, gets enough bounded cross-file context to establish important contracts, performs focused specialist reasoning, and cannot turn an unsupported suspicion into a final finding.

The system should also be able to explain whether any missed gold finding was caused by selection, model reasoning, verification, or review-budget limitations.
