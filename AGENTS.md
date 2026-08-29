# AGENTS.md

## Small-Model Review Architecture Migration

This repository is executing a staged migration of the small-model code-review path.

Before modifying the small-model review architecture, read:

- `docs/small-model-review-roadmap.md`
- `docs/codex-agent-swarm.md`

These documents define the implementation order, architectural constraints, promotion gates, and agent responsibilities.

## Orchestration Rules

1. Execute roadmap stages sequentially.
2. Do not begin stage `N+1` until stage `N` passes its promotion gate.
3. The root Codex agent acts as the orchestrator and owns stage state, task decomposition, integration, final review, and promotion decisions.
4. Codex subagents are explicitly authorized for this migration.
5. Use subagents only for bounded, well-scoped work.
6. Do not execute dependent roadmap stages concurrently.
7. Parallel code-editing agents must have disjoint write scopes.
8. Prefer separate subagents for implementation, tests/evals, and adversarial review.
9. Promotion must be based on deterministic tests and eval output, not subjective interpretation.
10. A failing promotion gate must trigger diagnosis and repair of the current stage.
11. Do not advance while required tests or eval gates are failing.
12. Never weaken an eval, fixture, test, threshold, budget, or architectural invariant merely to make a stage pass.
13. Do not hardcode behavior specifically for known eval fixtures.
14. Preserve a reproducible result/checkpoint for every completed stage.
15. Do not delete or disable the previous small-model path until Stage 9 shadow comparison passes.
16. `PARTIAL`, timeout, budget exhaustion, or insufficient context must never be promoted to `PASS`.

## Required Validation Layers

Every stage must be evaluated across three layers.

### A. Correctness

Mandatory:

- unit tests;
- integration tests;
- typecheck/build;
- lint/static checks;
- schema validation where applicable.

### B. Architectural Contract

Each stage defines invariants that must remain true. Examples:

- hard review-item limits are actually enforced;
- token budgets are hard limits, not advisory targets;
- model context expansion is bounded;
- evidence refers to the frozen repository snapshot;
- verifier behavior cannot silently rewrite unsupported findings into valid ones.

### C. Review-Quality Evaluation

Track, at minimum:

- selection recall;
- finding recall;
- precision;
- verified precision;
- token usage;
- model-call count;
- latency;
- partial-review rate.

Where relevant, also track:

- cross-file selection recall;
- cross-file finding recall;
- specialist/lens-specific recall;
- verifier rejection rate;
- context-expansion rate.

## Promotion Discipline

Infrastructure stages may be behavior-neutral, but must not introduce material quality regressions.

Stages explicitly intended to improve quality must show the expected improvement before promotion.

The authoritative promotion decision should eventually be produced by a deterministic command such as:

```bash
./scripts/check-review-promotion stage-N
```

Until that command exists, the orchestrator must manually apply the exact stage criteria in `docs/small-model-review-roadmap.md` and record the evidence used.

## Repair Loop

If a stage fails:

1. summarize the failing gate;
2. identify the specific regressed fixtures or invariants;
3. delegate focused diagnosis where useful;
4. repair the current stage only;
5. rerun correctness tests;
6. rerun evals;
7. rerun architectural checks;
8. promote only after all required gates pass.

Default autonomous repair limit: **3 repair attempts per stage**.

After three unsuccessful attempts, mark the stage blocked and report the failing metrics/tests, suspected root cause, attempted fixes, and recommended next investigation.

## Commit / Checkpoint Policy

Each promoted stage should correspond to a clean checkpoint, commit, or PR.

Preferred sequence:

1. eval baseline;
2. task/result contracts;
3. changed-symbol units;
4. interaction units + risk selector;
5. selection audit;
6. review lenses;
7. bounded context expansion;
8. candidate verifier;
9. routing + escalation + shadow mode.

Do not mix unrelated architectural stages into the same checkpoint.
