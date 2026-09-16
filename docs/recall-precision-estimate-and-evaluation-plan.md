# Recall and Precision Estimate and Evaluation Plan

## Purpose

This document records the evidence, estimates, and evaluation process for improving the small-model candidate and finding path.

The goal is to increase correct finding recall and precision without increasing inference cost or weakening the review contracts.

These estimates are derived from completed artifacts. They are not guaranteed forecasts.

## Evidence sources

- [Three-repetition control result](../.quality/evals/runs/2026-09-15T16-25-54-303Z-be727966-6797-4bd4-8746-e942b5322e9f/result.json)
- [Phase 5 relationship-packing findings](./phase-5-relationship-packing-findings.md)
- [Promoted host-default baseline](../evals/agentsmith/baselines/component-small-host-defaults.json)

The three-repetition control is the primary source for the current quality estimate. The host-default baseline supplies additional near-miss, evidence, and verifier diagnostics.

## Current measured control

The Phase 5 control contained 33 scored live repetitions and used the same host-default behavior that remains authoritative after Phase 5 cleanup.

| Metric | Control result |
|---|---:|
| Selection recall | 62.5% |
| Candidate finding recall | 37.5% |
| Candidate finding precision | 16.7% |
| Verified finding recall | 0% |
| Verified finding precision | 0% |
| Selection-miss attributions | 9 |
| Model-miss attributions | 9 |
| Verification-rejection attributions | 6 |
| Coverage/budget failures | 0 |
| Partial runs | 0 |
| Error runs | 0 |
| Model calls | 93 |
| Input tokens | 79,395 |

The control result demonstrates that the pipeline and provider completed successfully. The dominant failures are quality failures in selection, candidate generation, and verification—not timeout, provider, or JSON infrastructure failures.

## Failure-family evidence

The repeated control results identify three separate intervention targets:

| Failure family | Repeated result | Likely owning stage |
|---|---|---|
| Async timer lifecycle | Required work item selected, expected defect not emitted | Candidate generation |
| Python timeout unit conversion | Required work item selected, expected defect not emitted | Candidate generation |
| TypeScript nullable caller | Required work item selected, expected defect not emitted | Candidate generation |
| Authorization guard | Candidate emitted but not accepted by verification | Evidence/verification |
| Pagination boundary | Candidate emitted but not accepted by verification | Evidence/verification |
| Budgeting source-label and currency-unit cases | Gold work item omitted by selection | Selection/context coverage |

The async timer case is especially diagnostic: graph recall and context coverage were complete, candidate calls completed, the expected candidate was absent, and a false-positive candidate was emitted. This isolates the core failure to candidate reasoning and candidate quality.

## Near-miss evidence

The host-default baseline reports the following candidate-stage diagnostics across applicable positive cases:

| Diagnostic | Measured value |
|---|---:|
| Changed-file overlap | 100% |
| Changed-region overlap | 75% |
| Category compatibility | 87.5% |
| Severity compatibility | 50% |
| Triggering-value recall | 39.6% |
| Violated-invariant term recall | 17.7% |
| Observable-impact term recall | 21.8% |
| Evidence-request completeness diagnostic | 43.75% |
| Locator validity | 100% |
| Structured-output failures | 0% |
| Citation repairs | approximately 0.89 per applicable run |

The model often sees relevant code and identifies a nearby category, but it frequently fails to state the violated invariant and observable impact precisely. The current single call also asks the model to diagnose, classify, format, and plan evidence simultaneously.

## Estimated improvement range

### Candidate recall

The current 62.5% selection recall is an approximate upper bound for candidate recall if candidate generation alone improves while selection remains unchanged. The Phase 5 unit-preserving variant raised selection recall to 100% but left candidate recall at 37.5%, showing that selection improvement alone does not solve the quality problem.

The three repeated model-miss families provide the clearest candidate-recall opportunity. If the redesign converts those misses into correct candidates without creating new misses, candidate recall could improve by roughly 25–37.5 percentage points, depending on the applicable-case denominator and strict matching behavior.

This is a count-based ceiling, not a prediction. A successful change must demonstrate the movement in live repetitions.

### Verified recall

The authorization-guard and pagination cases produced candidates but failed verification. Recovering one or both of these cases could improve verified recall by roughly 12.5–25 percentage points on the current positive-case corpus, provided candidate generation remains stable.

This improvement is conditional: verification cannot recover a defect that candidate generation did not emit.

### Precision

Candidate precision is currently low enough that recall work cannot be accepted if it produces more unsupported candidates. The exact precision gain cannot be estimated from the existing artifacts because it depends on how the model responds to a changed output contract and prompt.

The measurable requirement is:

- candidate precision improves or does not regress;
- verified precision improves or does not regress;
- false-positive candidates do not increase merely because recall increases.

## Improvement strategy

The work preserves the small-model operating model:

- one bounded candidate call per selected work item;
- unchanged hard call, token, evidence, and timeout budgets;
- no review lenses;
- no relationship packing;
- no scope widening;
- deterministic host ownership of validation, evidence selection, attribution, verification contracts, and aggregation.

### R0 — Measurement calibration

Add diagnostic-only per-case candidate traces containing the selected unit, candidate response shape, near-miss dimensions, evidence outcomes, verifier outcome, and final publication result. Keep raw diagnostics out of the HTML report.

Make these metrics unambiguous and separately reported:

- candidate gold recall;
- candidate precision;
- verified gold recall;
- verified precision;
- evidence-request completeness;
- locator validity;
- verifier rejection and insufficient-evidence rates.

The strict oracle remains unchanged and no baseline is replaced.

### R1 — Simplified single-call candidate contract

Keep the existing one-call budget but reduce model-owned output to a versioned defect hypothesis:

```text
state: finding | no_finding | insufficient_context
candidates:
  file
  line
  optional endLine
  category
  severity
  trigger
  invariant
  impact
  confidence
```

The host derives title formatting, primary symbols, rule identifiers, evidence locator identities, and attribution fields deterministically from the frozen work item and validated claims.

### R2 — Deterministic evidence and verifier citations

Derive evidence selectors from the changed code, relationship edges, rules, and candidate category. Preserve hard evidence limits and report when required evidence cannot fit.

Use ordinal evidence references in the verifier contract and map them to canonical evidence IDs in host code. Invalid references remain explicit verifier diagnostics and do not trigger an additional model call.

### R3 — Task-specific prompt reduction

Replace the broad all-concerns prompt with a deterministic task question based on the work item’s relevant edge kinds, rules, and risk factors. The model should emit one concrete executable defect hypothesis or an explicit no-finding/insufficient-context state.

The prompt must continue to distinguish changed from supporting code, enforce frozen-snapshot scope, and prohibit style-only or hypothetical findings.

## Evaluation protocol

Each stage is evaluated independently through the component suite with frozen inputs. The evaluator must support stage selection for the registered suite, not only stage scoring inside a full live run.

Required stage inputs:

- Graph: frozen repository snapshot and graph manifest;
- Planning: frozen graph manifest;
- Ranking: frozen work items and risk factors;
- Selection: frozen ranked sequence and budgets;
- Projection: frozen selection input;
- Candidates: frozen projected context and work items;
- Evidence: frozen candidates and evidence requests;
- Verification: frozen candidates and resolved evidence;
- Aggregation: frozen verification results;
- Reporting: frozen aggregate result.

Stages outside the requested component must be `N/A`, never `partial` or `incomplete`.

For every behavior-affecting stage:

1. capture the pre-stage control;
2. implement one bounded change;
3. run applicable isolated component evaluations;
4. run the full live component suite for three repetitions;
5. compare aggregate and per-case results;
6. stop for manual review before the next stage.

## Promotion gates

A change is not a quality success merely because formatting, selection coverage, or diagnostics improve.

The stage must show:

- candidate recall improvement or no regression;
- candidate precision improvement or no regression;
- verified recall improvement or no regression;
- evidence completeness and citation validity improvement or no regression;
- all previously passing cases still passing;
- unchanged hard budgets;
- no increase in partials, errors, provider failures, or timeouts;
- repeatable results across three live repetitions.

Baseline replacement remains a separate decision after the evidence review. The paused candidate-quality roadmap does not resume automatically.

## Post-stage results record

After each implementation stage, append a result section containing:

| Result field | Required value |
|---|---|
| Stage and checkpoint | Commit or immutable workspace identity |
| Corpus/model/config | Exact hashes and profile identity |
| Candidate recall | Before, after, delta |
| Candidate precision | Before, after, delta |
| Verified recall | Before, after, delta |
| Verified precision | Before, after, delta |
| Evidence metrics | Completeness, resolution, citation validity |
| Root-cause movement | Model misses, selection misses, verifier rejections |
| Cost/reliability | Calls, tokens, latency, partials, errors |
| Repetition consistency | Three-run aggregate and worst case |
| Decision | Retain, repair, archive, or promote |

Each result must explain which hypothesis was supported or rejected and identify any remaining bottleneck before another stage is authorized.
