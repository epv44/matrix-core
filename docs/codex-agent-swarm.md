# Codex Agent Swarm / Orchestrator Construct

## Goal

Use Codex as a staged engineering orchestrator for the small-model review migration.

The swarm should increase implementation throughput and independent review quality **without sacrificing causal attribution between architecture changes and eval movement**.

The nine roadmap stages are a dependency chain.

Do **not** run nine implementation agents in parallel.

Instead, use parallel agents **inside the current stage** for independent implementation, tests/evals, and adversarial review.

## Core Operating Model

```text
                     ┌──────────────────┐
                     │   Orchestrator   │
                     │ owns task state  │
                     │ + promotion gate │
                     └────────┬─────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ Current Stage Spec │
                    └─────────┬──────────┘
                              │
              ┌───────────────┼────────────────┐
              ▼               ▼                ▼
       Implementation     Test / Eval      Reviewer /
          Agent(s)           Agent         Adversary
              │               │                │
              └───────────────┼────────────────┘
                              ▼
                     Deterministic tests
                              +
                         Eval suite
                              │
                    ┌─────────┴─────────┐
                    │                   │
                  PASS                 FAIL
                    │                   │
              checkpoint/commit      repair loop
                    │                   │
                    ▼                   └──► same stage
                 Stage N+1
```

# Agent Roles

## 1. Orchestrator

The root Codex agent owns the migration.

Responsibilities:

- read `AGENTS.md` and the migration docs;
- identify the first incomplete stage;
- inspect current repository state;
- decompose only the current stage;
- delegate bounded subtasks;
- ensure code-writing agents have disjoint write scopes;
- integrate changes;
- run required validation;
- obtain independent review;
- decide whether the deterministic promotion gate passed;
- update stage state;
- create a clean checkpoint;
- advance only after successful promotion.

The orchestrator is the **only role allowed to declare a stage complete**.

The orchestrator must not treat subagent self-reported success as sufficient evidence.

## 2. Builder Agent

Responsibilities:

- implement a bounded portion of the current stage;
- modify only the assigned files/scope;
- preserve architectural constraints;
- add or update implementation-level tests when appropriate;
- report files changed, behavior changed, tests added, and unresolved concerns.

The builder must not:

- advance roadmap stages;
- alter eval thresholds;
- weaken fixtures;
- widen review budgets without explicit stage requirements;
- modify unrelated architecture.

## 3. Test / Eval Agent

Responsibilities:

- inspect the stage requirements independently;
- add/update tests and evals needed to prove the behavior;
- prefer fixture coverage that distinguishes the targeted failure mode;
- run the relevant regression/eval suite;
- report metric deltas;
- identify regressed fixtures.

Where practical, this agent should not rely solely on tests authored by the builder.

The eval agent should detect selection miss, model miss, verification rejection, and budget/partial failure when the current stage supports that distinction.

## 4. Reviewer / Adversarial Agent

Responsibilities:

- review the integrated patch against the stage objective, architectural invariants, forbidden shortcuts, and regression risks;
- attempt to find budget bypasses, hidden scope widening, fixture-specific hacks, recall-damaging suppression, non-determinism, evidence-contract violations, and places where `PARTIAL` could become `PASS`.

The reviewer should be independent from the primary implementation path.

Read-only review is preferred unless the orchestrator explicitly assigns a repair.

# Stage Execution Protocol

## Step 1 — Load State

Read:

```text
AGENTS.md
docs/small-model-review-roadmap.md
docs/codex-agent-swarm.md
current migration state/checkpoints
```

Identify exactly one current stage. Do not begin implementation before confirming the previous stage is complete.

## Step 2 — Decompose the Current Stage

Create bounded subtasks.

Good example:

```text
Builder A:
  implement graph-edge interaction-unit generation
  write scope: src/review-units/**

Builder B:
  implement deterministic risk scoring
  write scope: src/risk/**

Eval Agent:
  add cross-file selector fixtures
  write scope: evals/small-model/**

Reviewer:
  no writes
  review architecture after integration
```

Bad decomposition:

```text
Agent A: implement Stages 3-5
Agent B: refactor reviewer architecture
Agent C: improve prompts
Agent D: optimize everything
```

# Parallelism Rules

Parallelize only when tasks are independent, dependencies are resolved, write scopes are disjoint, and integration behavior is understood.

Do not parallelize:

- Stage 4 before Stage 3 is promoted;
- Stage 7 before Stage 6 contracts exist;
- verifier work that depends on unfinished result schema;
- two agents editing the same selector/routing core;
- architecture changes whose eval effects need separate attribution.

The preferred use of swarm parallelism is:

```text
implementation
+
independent test/eval work
+
independent architecture review
```

rather than multiple agents simultaneously rewriting the same subsystem.

# Per-Stage Lifecycle

```text
IMPLEMENT
   ↓
TEST
   ↓
EVAL
   ↓
REVIEW
   ↓
PROMOTION GATE
   ↓
   ├── PASS → checkpoint → next stage
   │
   └── FAIL → diagnose → repair → TEST
```

No stage may skip the lifecycle.

# Promotion Gate Types

## Gate A — Correctness

Examples:

```text
unit tests
integration tests
build/typecheck
lint
schema validation
```

Any required correctness failure blocks promotion.

## Gate B — Architectural Contract

Examples:

```text
max work-item limit cannot be exceeded
token limit cannot be exceeded
context expansion cannot bypass typed APIs
verifier evidence resolves to frozen snapshot
PARTIAL cannot become PASS
selection ranking is deterministic
```

Any required architectural invariant failure blocks promotion.

## Gate C — Quality Evaluation

Track changes relative to the appropriate baseline/checkpoint.

Core metrics:

```text
selection_recall
finding_recall
precision
verified_precision
token_usage
model_calls
latency
partial_rate
```

Stage-specific metrics may include:

```text
cross_file_selection_recall
cross_file_finding_recall
lens_specific_recall
verifier_rejection_rate
context_expansion_rate
```

# Initial Threshold Guidance

Until a machine-readable promotion configuration is added, use:

```text
selection recall:
  max regression: 1 percentage point

finding recall:
  max regression: 2 percentage points

precision:
  max regression: 2 percentage points

token usage:
  max increase: 15%

autonomous repair attempts:
  max: 3
```

These are default regression tolerances.

A stage explicitly intended to improve a metric must show measurable improvement in that metric.

Examples:

```text
Stage 4:
  cross-file selection recall must improve

Stage 7:
  cross-file finding recall must improve

Stage 8:
  verified precision must improve without unacceptable recall collapse
```

The orchestrator must not reinterpret a failed numeric threshold as acceptable because the patch is otherwise appealing.

# Repair Protocol

When promotion fails, produce a concrete failure package.

Example:

```text
Stage 4 promotion failed.

Correctness:
  PASS

Architecture:
  PASS

Eval:
  selection_recall       0.81 → 0.87  PASS
  finding_recall         0.78 → 0.75  FAIL
  precision              0.82 → 0.83  PASS
  token_usage            -9%          PASS

Regressed fixtures:
  changed-interface-03
  error-contract-07

Constraint:
  Do not increase max work-item budget.

Repair objective:
  recover the two regressed fixtures without undoing the
  cross-file selection improvement.
```

Delegate diagnosis/repair against the failure package. Do not simply tell a repair agent to “make the stage pass.”

# Repair Attempt Limit

Default:

```text
3 autonomous repair attempts
```

If all fail, mark the stage `BLOCKED` and report the failed gate, current metrics, regressed fixtures, attempted repairs, suspected cause, and next recommended experiment.

Do not silently continue to the next stage.

# Independent Review Timing

Run adversarial review:

1. after builders complete their work;
2. after integration;
3. before final promotion.

For high-risk stages, the orchestrator may run a second independent review after a repair.

High-risk stages:

```text
Stage 4 — selector/risk ranking
Stage 7 — context expansion
Stage 8 — verification
Stage 9 — routing/pass semantics
```

# Recommended Swarm Pattern by Stage

## Stage 1 — Eval Baseline

```text
Agent A: fixture/harness implementation
Agent B: metric tests
Agent C: fixture quality review
```

No improvement required.

## Stage 2 — Contracts

```text
Agent A: ReviewUnit/ReviewTask schema
Agent B: malformed-output tests
Agent C: compatibility review
```

Expected behavior-neutral.

## Stage 3 — Changed-Symbol Units

```text
Agent A: symbol-unit implementation
Agent B: unit-generation tests
Agent C: eval comparison/review
```

## Stage 4 — Interaction Units + Selector

```text
Agent A: interaction-unit generation
Agent B: risk scoring / selector work if write scope is disjoint
Agent C: cross-file eval fixtures/tests
Agent D: adversarial architecture review
```

If A and B would edit the same central selector files, serialize them instead.

## Stage 5 — Selection Audit

```text
Agent A: audit instrumentation
Agent B: failure-classification tests
Agent C: trace usability review
```

## Stage 6 — Review Lenses

```text
Agent A: correctness/default lens
Agent B: specialist lens migration where scopes are disjoint
Agent C: old-vs-new specialist eval comparison
Agent D: false-positive review
```

## Stage 7 — Context Expansion

```text
Agent A: request contract/resolver
Agent B: expansion-limit tests
Agent C: cross-file evals
Agent D: adversarial scope-widening review
```

Reviewer should specifically try to bypass round limits, reference limits, token limits, typed request kinds, and the repo-browsing prohibition.

## Stage 8 — Verification

```text
Agent A: verifier implementation
Agent B: evidence validator
Agent C: precision/recall eval
Agent D: adversarial false-finding review
```

Verifier and deterministic evidence validation should remain separable enough to diagnose failures.

## Stage 9 — Routing + Shadow

```text
Agent A: routing/escalation
Agent B: shadow comparison/reporting
Agent C: end-to-end tests
Agent D: PASS/PARTIAL semantic review
```

# Persistent Migration State

The repository should eventually maintain machine-readable state similar to:

```json
{
  "roadmapVersion": 1,
  "currentStage": 4,
  "completedStages": [1, 2, 3],
  "lastSuccessfulStage": 3,
  "stageResults": {
    "3": {
      "commit": "abc1234",
      "promotion": "PASS",
      "selectionRecall": 0.82,
      "findingRecall": 0.78,
      "precision": 0.83
    }
  }
}
```

The purpose is restartability. A fresh Codex session should determine the active roadmap, completed stages, authoritative checkpoint, next stage, and previous metrics without depending on conversation history.

# Recommended Root Codex Prompt

```text
Execute the small-model review migration defined in
`docs/small-model-review-roadmap.md`.

Act as the primary orchestrator.

Follow `AGENTS.md` and `docs/codex-agent-swarm.md`.

For each stage:

- inspect current state and requirements;
- decompose only the current stage into bounded work;
- use parallel subagents only for independent/disjoint subtasks;
- ensure implementation is accompanied by tests;
- use an independent agent to review the integrated change;
- run required correctness, architectural, and eval checks;
- run the deterministic promotion gate if available;
- if promotion fails, diagnose and repair only the current stage;
- do not advance until the stage passes;
- update migration state after successful promotion;
- create a clean checkpoint before starting the next stage.

Do not implement dependent roadmap stages concurrently.

Never weaken tests, evals, thresholds, budgets, or architectural
invariants merely to make a stage pass.

Begin from the first incomplete stage.
```

# What the Orchestrator Must Never Do

Do not:

- spawn one agent per roadmap stage and run all nine simultaneously;
- accept a builder's statement that tests passed without verifying;
- change eval thresholds in the same patch that fails them;
- increase work-item/context budgets merely to recover recall;
- allow model-directed unrestricted repository browsing;
- let verifier output silently manufacture supporting evidence;
- conflate selection failure with model failure;
- promote timeout/partial/insufficient-context to PASS;
- delete the old path before shadow comparison;
- merge unrelated stage changes because they are convenient.

# Future Automation

After the initial roadmap is working, move numeric promotion rules out of Markdown into machine-readable configuration, for example:

```text
evals/small-model/promotion-gates.yaml
```

and implement a deterministic command such as:

```bash
./scripts/check-review-promotion stage-4
```

The command should:

1. run/verify required tests;
2. load previous-stage metrics;
3. load candidate metrics;
4. apply stage-specific thresholds;
5. list failing metrics/fixtures;
6. return exit code `0` only when promotion is allowed.

At that point the Markdown defines **intent and architecture**, while code/config defines the **non-negotiable promotion decision**.

# Success Condition

The swarm is working correctly when Codex can execute multiple stages autonomously while preserving:

- sequential causal attribution;
- independent test/review pressure;
- deterministic promotion;
- bounded repair;
- reproducible checkpoints;
- evidence that review quality is actually improving.

The goal is not maximum agent concurrency.

The goal is a reliable automated engineering/research loop.
