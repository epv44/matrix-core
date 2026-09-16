# Phase 5 Relationship-Preserving Packing Findings

## Status

Phase 5 is **not promoted**.

The implementation was evaluated as three variants:

- control: no packing strategy;
- `unit-preserving`: relationship groups remain atomic while individual units retain separate model calls;
- `shared-task`: relationship groups are merged into one bounded dispatch task.

The host default remains unchanged. No baseline was replaced.

## Evaluation evidence

All three variants used the same active corpus, `partitioned-interactions` mode, live replay, and three repetitions. Each variant produced 39 result rows: 33 scored runs and 6 diagnostic-only runs. All artifacts use evaluation schema version 8 and corpus hash `076a76cad55f88cabad56179e7b370a74cf8d32876686a36eb5927988ffb50e2`.

Artifacts:

- Control: `.quality/evals/runs/2026-09-15T16-25-54-303Z-be727966-6797-4bd4-8746-e942b5322e9f/result.json`
- Unit-preserving: `.quality/evals/runs/2026-09-15T16-27-43-333Z-bf788cac-c176-4194-b94e-ba4a55c12c84/result.json`
- Shared-task: `.quality/evals/runs/2026-09-15T16-29-06-372Z-993b584a-0a5d-4ebd-8f14-5baec0b0a941/result.json`
- Latest pre-Phase-5 control: `.quality/evals/runs/2026-09-15T02-46-57-627Z-dfe94e0c-da5f-4986-b24b-f9194b6e31a0/result.json`

### Aggregate results

| Metric | Control | Unit-preserving | Shared-task |
|---|---:|---:|---:|
| Selection recall | 62.5% | 100% | 62.5% |
| Candidate finding recall | 37.5% | 37.5% | 37.5% |
| Candidate finding precision | 16.7% | 15.8% | 12.5% |
| Verified finding recall | 0% | 0% | 0% |
| Model-miss attributions | 9 | 9 | 9 |
| Selection-miss attributions | 9 | 0 | 3 |
| Coverage/budget-failure attributions | 0 | 6 | 6 |
| Verification-rejection attributions | 6 | 9 | 6 |
| Model calls | 93 | 99 | 114 |
| Input tokens | 79,395 | 127,800 | 125,598 |
| Partial runs | 0 | 0 | 0 |
| Error runs | 0 | 0 | 0 |

The aggregate finding metrics use the report's scored micro denominator. Earlier one-repetition summaries used an unweighted mean across applicable cases; that is why those summaries reported 44.4% candidate recall. The two figures are different aggregations, not contradictory run results.

## Conclusions

### The primary quality hypothesis was not supported

Phase 5 was intended to improve review quality for large or noisy changes by keeping semantically related code together under existing hard budgets. It did not improve candidate recall, candidate precision, or verified finding recall.

The result is repeatable:

- all variants had 37.5% candidate recall;
- all variants had 0% verified recall;
- all variants produced 9 model-miss attributions;
- no variant recovered a gold finding that control missed.

### Unit-preserving improved selection coverage, but not review quality

`unit-preserving` raised selection recall from 62.5% to 100% and eliminated selection-miss attributions. However, six misses became coverage/budget failures because required groups could not fit atomically under the existing limits. It also increased total calls from 93 to 99 and input tokens from 79,395 to 127,800.

This is a selection behavior change, not a quality win. The selected context did not cause the small model to generate the expected findings.

### Shared-task was not competitive

`shared-task` retained the control selection recall, lowered candidate precision to 12.5%, produced the highest call count, and introduced six coverage/budget failures. It did not improve any finding-quality metric.

### The pipeline completed; the model quality oracle failed

The result status must be interpreted in two dimensions:

- `executionStatus = completed` means the pipeline and model calls completed.
- `evalStatus = fail` means the expected finding oracle was not satisfied.

The zero partial and zero error rates show that the Phase 5 comparison did not fail because of the harness or provider. The failing quality results were ordinary model misses, selection misses, budget failures, or verifier rejections.

The `async-resource-lifecycle` control case confirms this distinction. In the latest pre-Phase-5 control and the current control, the expected timer-leak finding was selected for review but not generated. The candidate generation, verification outcomes, and quality metrics were equivalent. This failure therefore predates Phase 5.

## Causal interpretation

Existing interaction work items already include the relevant relationship sides. A caller/callee interaction unit, for example, already contains the changed symbol, the related caller, the relationship edge, and the supporting code. Phase 5 therefore mostly changed unit accounting and dispatch grouping; it did not add materially new model-visible evidence for the current fixtures.

The observed failure chain is:

```text
relationship selection
        ↓
context already available in interaction units
        ↓
candidate generation still misses expected defect
        ↓
verifier cannot recover a candidate that was never emitted
        ↓
verified finding recall remains 0%
```

The next quality intervention should target candidate-generation reasoning and verifier acceptance, not assume that additional relationship packing will improve recall.

## Implementation and evaluation gaps

The Phase 5 review found gaps that must be addressed before any packing strategy can be promoted or treated as a stable optimization:

1. Packed-task token estimates do not calculate the complete prompt cost from the actual model profile, bounded question, locator table, output reservation, and selector contract. The implementation uses a fixed overhead plus deduplicated payload estimates.
2. `omittedGroups` is always reported as zero. Group-level omission accounting and the required deterministic omission reason are incomplete.
3. Relationship groups are inferred from graph edges rather than explicit fixture-declared minimum-evidence groups.
4. Shared-task candidate attribution uses the synthetic packed task ID and does not fully propagate all original unit IDs into candidate attribution.
5. Execution coverage and planner manifests can represent packed tasks instead of original selected units, making shared-task selection accounting ambiguous.
6. Packing diagnostics are emitted, but packing metrics are not fully represented as aggregate report/topline metrics.
7. Both micro and macro denominators need to remain explicit in reports so aggregate micro recall is not confused with an unweighted case average.
8. The implementation is variant-gated, so the host default and the control path remain unchanged.

## Future direction

- Retain these artifacts as historical Phase 5 evidence.
- Do not replace the promoted baseline based on this work.
- Keep packing strategies limited to controlled evaluation until attribution, token accounting, group omission, and aggregate metrics are repaired.
- Prioritize candidate-generation and verifier investigation for the next quality phase.
- Require a measurable improvement in candidate-context or candidate recall before promoting future packing changes.
