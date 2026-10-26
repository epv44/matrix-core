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

### Strict versus substantive candidate recognition

The strict candidate oracle remains the promotion metric, but it is not sufficient to explain near misses. A candidate with the correct defect can be rejected because its severity, title wording, evidence request, or host-formatted claim sections differ from the fixture. The substantive metrics below are diagnostic only; they do not replace strict candidate recall, precision, verified recall, or promotion gates.

#### P0 measurement contract

The diagnostic must evaluate the model's understanding independently from exact production labeling:

1. **Matching order.** For every gold finding, evaluate every eligible candidate emitted by every candidate call. Do not first assign one nearest candidate to one gold finding. Case capability is true when any eligible emitted candidate substantively matches the gold finding.
2. **Per-call binary recognition.** A completed candidate call is `recognized` or `not recognized`; there is no fuzzy score. A call is recognized when any candidate in that call substantively matches any applicable gold finding.
3. **Reliability denominators.** Report completed-call reliability and attempted-call reliability separately. Provider failures remain explicit rather than disappearing from the quality denominator.
4. **Finding fidelity.** Report recognized finding-emitting calls divided by completed calls that emitted findings. Completed `no_finding` calls count against completed-call recognition but are excluded from the finding-fidelity denominator.
5. **Substantive decision.** Require file/range overlap, compatible semantic/security domain, required behavioral concepts, and no contradictory or forbidden claim. Do not require exact severity, title wording, evidence requests, or host-generated `Trigger`/`Invariant`/`Impact` formatting.
6. **Component diagnostics.** Report location, domain, trigger, invariant, impact, and contradiction-free booleans/ratios to explain binary misses. These diagnostics never grant promotion credit.

The report must expose at least:

| Metric | Definition |
|---|---|
| Case capability | Gold cases recognized by any eligible emitted candidate / applicable gold cases |
| Completed-call reliability | Recognized completed calls / completed calls |
| Attempted-call reliability | Recognized calls / attempted calls, including provider failures |
| Finding fidelity | Recognized finding-emitting calls / completed calls that emitted findings |
| Provider failure rate | Provider-failed calls / attempted calls |

For the captured auth run, the expected diagnostic interpretation is case capability `100%`, completed-call recognition `3/4 = 75%` when four calls complete and one emits `no_finding`, finding fidelity `3/3 = 100%`, attempted-call reliability `3/4 = 75%`, and provider failure rate `0/4 = 0%`. If one of the four attempts is a provider failure instead, the corresponding completed denominator is `3`, attempted reliability is `3/4`, and provider failure rate is `1/4`; the report must make this distinction visible.

The auth-guard case is the current reference example: the 4B sampling treatment emitted three semantically relevant findings and one `no_finding`, while strict candidate recall remained zero because severity, category, exact wording, and evidence requirements did not all match. That is evidence for improving measurement first, not evidence for weakening the strict oracle.

#### Explicit substantive concept contract

The substantive diagnostic MUST use an explicit, versioned fixture contract. It MUST NOT infer the contract from observed model output, and it MUST NOT rely on an optional fallback whose semantics vary by fixture.

Every targeted positive candidate MUST declare:

```yaml
substantiveConcepts:
  domain: security
  triggerGroups:
    - [member]
    - [logical_and, short_circuit_guard]
    - [delete, user]
  invariantGroups:
    - [admin]
    - [role_check]
  impactGroups:
    - [member]
    - [delete, user]
  forbidden: []
```

Outer groups are required (`all-of`); entries within one group are alternatives (`any-of`). A substantive match requires every trigger, invariant, and impact group to be satisfied. Forbidden concepts or contradictory polarity invalidate the candidate.

The eight positive component cases and the conformance-positive case have enough reviewed source, rationale, description, and evidence data to populate this contract. Concept declarations MUST be reviewed against the frozen fixture before any model treatment runs. Model outputs MUST NOT be used to add or remove concepts.

The evaluation schema MUST be versioned for this required positive-case field. Existing baselines remain immutable; the new substantive metrics have no historical comparator unless they can be reconstructed from an identical contract.

#### Modular normalization boundary

The evaluator MUST NOT introduce one large global semantic object containing every defect concept. Shared normalization is limited to generic, reusable syntax and language behavior and is split into independently tested modules:

```text
tools/agentsmith-evals/src/substantive/
  tokenizer.ts
  identifiers.ts
  operators.ts
  polarity.ts
  domains.ts
  index.ts
```

The shared modules MAY normalize:

- case, whitespace, punctuation, and token boundaries;
- camelCase, snake_case, kebab-case, dotted identifiers, and quoted values;
- numeric literals;
- `&&`, `and`, and `conjunction` to `logical_and`;
- `||`, `or`, and `disjunction` to `logical_or`;
- explicit short-circuit wording to `short_circuit_guard`;
- a small reviewed set of generic inflection and negation forms;
- finite review-domain compatibility.

Fixture-specific concepts such as `member`, `cash_snapshot`, or `unauthorized_delete` remain in the fixture contract. They MUST NOT become entries in the shared registry. The registry MUST expose a version/hash, reject duplicate or ambiguous aliases, and never use embeddings, fuzzy similarity, model output, or fixture-ID conditionals.

#### Substantive matcher behavior

The substantive matcher MUST remain a separate diagnostic path. For each positive gold candidate it MUST evaluate every emitted candidate from every candidate call before deciding recognition. It MUST NOT perform nearest-candidate assignment first.

For each candidate, it evaluates:

1. file and line-range overlap;
2. compatible semantic domain;
3. normalized trigger groups;
4. normalized invariant groups;
5. normalized impact groups;
6. forbidden concepts and deterministic polarity contradictions.

The candidate narrative is the title plus description. Host-generated `Trigger`, `Invariant`, and `Impact` labels MAY be parsed for component diagnostics, but their presence or formatting MUST NOT be required for substantive recognition.

Severity, title wording, evidence requests, evidence completeness, and host formatting remain separate diagnostics. The strict candidate matcher, finding matcher, verifier, promotion status, and hard budgets MUST remain unchanged.

#### P0 implementation and execution plan

1. Add and validate the explicit substantive concept contract and versioned modular normalization boundary described above. Repair the diagnostic matcher without changing strict matching. Normalize behavioral concepts deterministically, including operator aliases such as `&&`/conjunction/short-circuit, without adding fixture-specific matcher rules. Keep severity, title, evidence completeness, and host formatting in separate diagnostics.
2. Thread immutable candidate-batch boundaries into the evaluator so each attempted call retains its candidates, completion/error state, and `no_finding` state. A provider error contributes only to attempted-call and provider-failure denominators; a completed empty result contributes to completed-call non-recognition.
3. Add unit tests for all-gold-candidate matching, one completed `no_finding`, provider failure, finding fidelity, semantic category compatibility, forbidden-term rejection, and unchanged strict recall.
4. Re-score the captured auth artifacts first. The expected result is the denominator behavior described above; strict candidate recall and promotion status remain unchanged.
5. Run three matched repetitions for the 4B and 9B treatments with the same fixture, prompt, thinking mode, sampling, output/context budgets, timeout, and verifier. Compare substantive case capability, completed/attempted reliability, finding fidelity, strict recall/precision, verified recall/precision, calls, tokens, latency, partials, and errors. Do not select a new default model from a single run.
6. Run the full component suite only after the auth diagnostic contract is stable. Record traces and per-case diagnostics, then stop for manual review before any later quality intervention.

The exit criteria for this P0 measurement stage are:

- all required substantive metrics are present with explicit numerator/denominator values or `N/A`;
- the auth run reports the expected case/per-call/fidelity distinction;
- strict candidate and verified metrics are byte-for-byte definitionally unchanged;
- matching is deterministic across repeated evaluation of identical artifacts;
- provider failures, `no_finding`, and partial execution cannot be conflated;
- unit, integration, build, lint, and eval checks pass;
- no promotion or baseline replacement occurs based solely on the diagnostic metrics.

#### P0 improvement loop and stop conditions

The P0 measurement work is followed by a bounded improvement loop. Measurement and strict promotion semantics are held constant while one treatment is evaluated at a time.

Use a frozen `host-defaults` control with the same model, prompt, inference mode, sampling parameters, budgets, timeout, verifier, fixture corpus, evaluator version, and policy hash for every comparison. Each treatment must run three matched repetitions on the targeted positive diagnostic cases before it can be retained.

Each iteration MUST:

1. apply exactly one bounded intervention;
2. run the targeted positive diagnostic component cases;
3. persist JSON, HTML, and trace artifacts;
4. compare the treatment with the frozen control and prior treatment;
5. record substantive, strict, reliability, cost, and latency metrics;
6. retain the treatment only if all exit criteria pass.

An intervention MUST NOT modify fixture expectations, strict oracle semantics, metric definitions, hard model-call/token/evidence/timeout budgets, or promotion thresholds. Lenses and additional inference calls are out of scope.

The P0 improvement loop exits successfully only when:

- substantive recognition is measured correctly and deterministically;
- case recognition is present for every targeted positive diagnostic case;
- completed-call substantive recognition improves over control;
- attempted-call substantive recognition is at least 75%;
- strict candidate recall does not regress;
- candidate precision does not regress;
- verified recall and verified precision do not regress;
- provider failure, partial, and timeout rates do not regress;
- the improvement reproduces across all three matched repetitions;
- no retained change weakens strict oracle semantics or hard budgets.

After a treatment passes the targeted gate, run the full component suite for three repetitions and apply the same criteria before any baseline or promotion decision.

If three consecutive bounded interventions fail to improve completed-call substantive recognition, stop the loop and record the best treatment, control/treatment deltas, per-case diagnostics, provider/runtime evidence, remaining bottleneck, and recommended next investigation. No fourth intervention may begin without manual review.

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

#### Controlled candidate-generation arms

R1 behavior is evaluated through explicit, mutually exclusive candidate-generation arms. The live component suite accepts `--arm` and records the selected arm in suite configuration. The arms use the same fixtures, selected work items, model, budgets, verifier, and repetition count:

| Arm | Candidate output | Metadata ownership | Evidence ownership |
|---|---|---|---|
| `host-defaults` | legacy compact contract with bounded selectors | model, with host fallback | model selectors plus host defaults |
| `deterministic-evidence` | legacy compact contract | model | host-generated deterministic requests |
| `host-derived-metadata` | legacy compact contract | host-normalized title, symbol, and rule | model requests |
| `simplified-contract` | R1 semantic contract | host | host-generated deterministic requests |

`host-defaults` is the control arm. `simplified-contract` remains the normal current path; the other arms are opt-in diagnostic treatments. Arms must not add model calls or change global budgets. Candidate-stage cache keys and descriptor fingerprints include the arm. Compare arms with identical live-suite commands except for `--arm`, for example:

```bash
npm run eval -- --target agentsmith --suite component --model small --tier live --repeat 3 --arm host-defaults --format html --output .quality/evals/arms-control.html
npm run eval -- --target agentsmith --suite component --model small --tier live --repeat 3 --arm deterministic-evidence --format html --output .quality/evals/arms-deterministic-evidence.html
npm run eval -- --target agentsmith --suite component --model small --tier live --repeat 3 --arm host-derived-metadata --format html --output .quality/evals/arms-host-metadata.html
npm run eval -- --target agentsmith --suite component --model small --tier live --repeat 3 --arm simplified-contract --format html --output .quality/evals/arms-simplified.html
```

The arm comparison is diagnostic until a pre-declared treatment is shown to improve candidate recall/precision without violating partial, error, latency, call, token, or determinism gates.

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

## Diagnostic implementation: Ollama thinking inspection

Thinking inspection is diagnostic-only. It is not a candidate-generation arm, does not alter the production inference path, and must not contribute to promotion metrics. The production candidate request remains `think: false` with Ollama structured output and strict host-side validation.

Direct probes against the installed `qwen3.5:9b-q4_K_M` model and Ollama `0.32.5` produced this matrix:

| Request | `response` | `thinking` |
|---|---|---|
| `think: false`, no format | valid JSON | empty |
| `think: true`, no format | valid JSON | reasoning trace |
| `think: false`, `format: "json"` | valid JSON | empty |
| `think: true`, `format: "json"` | empty | JSON-like answer |

The observed failure is therefore specific to the interaction between thinking and structured output for this installed model/runtime, not a general failure of thinking. The `think:true`/no-format request may be used only as a side-by-side diagnostic probe using the exact candidate prompt. Its response and thinking fields are inspected by humans; the probe response is never passed into verification, aggregation, baseline calculation, or user-visible review output. The thinking field must never be used as a fallback answer channel.

An opt-in full-suite diagnostic run using `thinking-no-format` was also attempted on 2026-09-29. It did not produce an eval report: after more than 34 minutes it had completed one case with an error, made two model calls, consumed 6,993 reported output tokens, and stopped advancing on the next candidate execution. The run was terminated. This is a diagnostic latency/budget finding, not a quality result and not eligible for baseline comparison.

## Provider migration decision: bounded reasoning with vLLM

The 2026-10-07 Ollama context/output-budget experiment is archived as a failed diagnostic and is not a baseline. Its generated HTML, JSON, and stream traces were removed; the experimental `short-reasoning-v1` prompt was removed. The retained conclusion is that Ollama generated long Qwen reasoning traces but did not reliably transition to final structured content before provider timeout. Prompt instructions and total `num_predict` reduction did not provide an enforceable reasoning budget.

The next provider experiment uses vLLM through the existing `ReviewProvider` interface. vLLM is selected by `provider: vllm`, serves the OpenAI-compatible `/v1` API, uses `--reasoning-parser qwen3`, requests JSON Schema output, and passes a separate `thinking_token_budget`. vLLM documents separate `reasoning` and final `content` fields, Qwen3 reasoning parsing, structured outputs, and bounded reasoning-token control. Native Apple Silicon support is experimental and CPU-only; Metal acceleration requires the separate `vllm-metal` plugin, so local feasibility must pass before provider integration is promoted.

The first vLLM diagnostic is one `auth-guard-bypass` repetition using the 4B Qwen family, an 8,192-token server context (the largest configuration that fit this laptop during the initial probe), a context-fitting output budget, and a 512-token reasoning budget. The provider must reject an output budget that cannot fit alongside the exact tokenized prompt and safety reserve; it must never silently reduce the requested budget. The result must record reasoning/content separation, valid JSON, strict and substantive metrics, latency, calls, tokens, provider failures, and partials. If the 512-token arm truncates the decisive reasoning path, a single 1,024-token sensitivity arm may be run before manual review. Three matched repetitions and then the full component suite are required before vLLM can become the default provider; no baseline replacement occurs automatically.

### Initial vLLM-Metal feasibility result

The first local feasibility probe used `vllm-metal 0.31.0`, `mlx-community/Qwen3.5-4B-MLX-4bit`, and the OpenAI-compatible API. A 16,384-token server context could not allocate KV cache on the laptop. An 8,192-token context loaded once, but subsequent startup under memory pressure failed. A 4,096-token context loaded successfully.

The 4,096-token server produced the following diagnostic result:

| Request | Reasoning/content result |
|---|---|
| thinking, no schema | Separate `reasoning` and final `content`; valid content was returned. |
| thinking + JSON Schema, `thinking_token_budget=64` | `reasoning` consumed all 300 requested output tokens; `content` was null; `finish_reason=length`. |
| thinking + JSON Schema, `thinking_token_budget=512` | Earlier probe likewise returned JSON-like text in `reasoning` with null final content. |

This rejects promotion of the vLLM path on this exact local runtime/model configuration. The provider adapter and bounded-context handling are retained as an integration seam, but no component eval or baseline promotion is valid until a serving configuration demonstrates both a bounded reasoning transition and schema-valid final content. The observed failure is a provider/model behavior result, not an eval fixture result.

### Checkpoint and structured-output configuration clarification

The serving stack is `vllm-metal 0.31.0` on top of vLLM `0.31.0`, with MLX `0.32.1`, `mlx-lm 0.32.0`, and `mlx-vlm 0.6.17`. The checkpoint `mlx-community/Qwen3.5-4B-MLX-4bit` is a community-converted MLX SafeTensors checkpoint derived from `Qwen/Qwen3.5-4B`; it is not the separate `vllm-mlx` server project. vLLM-Metal uses MLX as its Apple Silicon execution backend and lists the Qwen3.5 family as supported. The exact 4B checkpoint remains an explicit compatibility variable because it is not the example checkpoint in the support table.

The target server configuration is:

```text
--reasoning-parser qwen3
--reasoning-config '{"reasoning_start_str":"<think>","reasoning_end_str":"</think>"}'
--structured-outputs-config.enable_in_reasoning=false
--default-chat-template-kwargs '{"enable_thinking":true}'
```

These options have different responsibilities. `enable_thinking` is a chat-template default and controls whether Qwen enters thinking mode; MatrixCore still sends request-level `chat_template_kwargs.enable_thinking` explicitly. `enable_in_reasoning=false` controls vLLM guided decoding and prevents the final JSON grammar from being applied to reasoning tokens. The intended result is unconstrained `message.reasoning` followed by schema-constrained final `message.content`.

The contract probe now verifies that the requested model is present in `/v1/models`, removes JSON-format instructions from the minimal probe prompt, records the loaded model list, and validates adapter content as JSON rather than merely checking that content is non-empty. The vLLM `thinking-structured` candidate path also delegates serialization instructions to the provider schema; the Ollama prompt contract is unchanged.

The earlier `enable_in_reasoning=true` result, where JSON-like output appeared in `reasoning` and final `content` was empty, is retained as a causal control. It must not be treated as proof that this checkpoint is incompatible. The compatibility gate remains: three matched target repetitions must produce non-empty reasoning, schema-valid final content, a terminating finish reason, budget compliance, and zero provider failures before any component eval or baseline decision.

### Target contract probe result — 2026-10-15

The target server was started with `vllm-metal 0.31.0`, `mlx-community/Qwen3.5-4B-MLX-4bit`, `--max-model-len 4096`, `--gpu-memory-utilization 0.5`, `--reasoning-parser qwen3`, explicit `<think>` boundaries, `--structured-outputs-config.enable_in_reasoning=false`, and `--default-chat-template-kwargs '{"enable_thinking":true}'`. Startup confirmed `enable_in_reasoning=False`, MLX GPU execution, and the exact requested model in `/v1/models`.

Artifact: `.quality/evals/vllm-contract-target-4096-output1024-reasoning512.json` with traces under `.quality/evals/vllm-contract-target-4096-traces/`.

| Probe | Configuration | Result |
|---|---|---|
| A | no thinking, no schema | `working`; stopped with content |
| B | thinking, no schema | `total-output-exhaustion`; all 1,024 output tokens were reasoning and no final content was emitted |
| C | no thinking, JSON Schema | `working`; schema-valid final content |
| D | thinking, JSON Schema, `enable_in_reasoning=false` | `working`; 319 reasoning tokens, 11 final content tokens, `finish_reason=stop`, schema-valid content `{"ok": true}` |

This confirms the target single-pass contract works for the structured arm. It also shows that a thinking/no-schema request is not a valid production response contract at this budget: without a final-content grammar, Qwen can consume the entire total output budget in reasoning. This is expected diagnostic evidence, not a promotion result. Three matched target repetitions and the full component evaluation remain required before provider or baseline promotion.

### Auth component verification result — 2026-10-15

The first MatrixCore auth-component run used the target vLLM-Metal server and the exact 4B MLX model for both candidate and verifier roles. The run used `thinking-structured`, the `simplified-contract` arm, `branch-analysis-v1`, streaming, temperature `0.6`, top-p `0.95`, top-k `20`, a 4,096-token context, a 1,024-token output budget, and a requested 512-token reasoning budget.

Artifacts:

- [HTML report](../.quality/evals/vllm-auth-guard-r1.html)
- [JSON report](../.quality/evals/vllm-auth-guard-r1.json)
- [stream traces](../.quality/evals/traces/2026-10-15T17-53-47-276Z-9c3a15c0-f7a3-41a6-bcbf-9d9d9edd098e/)

| Metric | Result | Interpretation |
|---|---:|---|
| Attempted model calls | 3 | One local work item completed; two failed at candidate parsing. |
| Completed calls | 1/3 | The run is partial and cannot be promoted. |
| Provider failures | 2/3 | Both failures exhausted all 1,024 output tokens in reasoning. |
| Valid final JSON responses | 1/3 | The successful response was `{"state":"no_finding","candidates":[]}`. |
| Auth finding recognition | 0 | No emitted candidate survived because the decisive work items did not emit content. |
| Reasoning/content separation | observed | The successful call had separate reasoning and final content fields. |
| Reasoning budget behavior | failed | Two calls generated 1,024 reasoning tokens despite the requested 512-token reasoning budget. |

The captured reasoning for the interaction work item correctly reached the member-session authorization bypass analysis, but it was truncated before final content. The local work item also reasoned toward the issue but was truncated. The third work item completed with `no_finding` and was not sufficient to establish the auth finding.

This rejects the three-repetition gate for the current configuration. It is a provider/model budget-transition failure, not evidence that the auth fixture is incorrect and not a strict-oracle failure. No three-repetition run or baseline decision is valid until the serving configuration reliably transitions from reasoning to schema-constrained content.

### Auth no-thinking comparison — 2026-10-15

A matched non-thinking run was executed against the same vLLM-Metal model, prompt variant, arm, sampling parameters, context, output budget, verifier, and auth fixture. Only `inferenceMode` changed from `thinking-structured` to `structured`. Port `8002` was used because the previous vLLM process left port `8001` unusable.

Artifact: [vllm-auth-guard-no-thinking-r1.json](../.quality/evals/vllm-auth-guard-no-thinking-r1.json) and [HTML report](../.quality/evals/vllm-auth-guard-no-thinking-r1.html).

| Metric | Thinking | No thinking |
|---|---:|---:|
| Runtime status | partial/error | completed |
| Provider failures | 2/3 | 0/4 |
| Completed calls | 1/3 | 4/4 |
| Valid structured responses | 1/3 | 4/4 |
| Candidate calls | 2 valid outputs unavailable | 3 findings/no-finding outputs |
| Strict auth finding recall | 0% | 0% |
| Model calls | 3 | 4 |
| Output tokens | 2,899 | 475 |
| Wall time | 143 seconds | 315.8 seconds |

The no-thinking model produced two valid but semantically wrong findings: both focused on a null session throwing instead of the actual defect, where a present `member` session bypasses the admin-only delete guard. The third candidate returned `no_finding`. One work item was also omitted by the existing candidate token budget, so this is a completed runtime with a coverage limitation, not a passing quality result.

This comparison isolates the immediate effect of thinking: disabling thinking removes the provider/content exhaustion failures, but does not improve auth finding quality. The remaining bottleneck is model reasoning/semantic candidate selection, with an additional selection/evidence-packing budget omission. Neither arm is eligible for baseline promotion.

## Bounded 4B semantic-diff experiment and SOTA control

### Current evidence

The later vLLM-Metal target contract supersedes the earlier provider-transition failure for the
specific `thinking-structured` configuration: bounded reasoning and schema-valid final content
are mechanically possible on the 4B checkpoint. The remaining auth result is a semantic
candidate failure. The frozen task contains the changed guard and the supplied `Session` type,
but the 4B model repeatedly selects a false null-session claim instead of the concrete state
where a present `member` session reaches `deleteUser`.

An earlier GPT-5.6 Luna review reportedly found the correct problem. That result was not saved
with an exact prompt or response, so it is evidence of possible model capability, not a
reproducible comparison yet. A 9B MLX checkpoint was attempted locally but exited after model
load and before its API server became ready; it produced no quality result and is not a control.

### SOTA diagnostic-control protocol

GPT-5.6 Luna is an external, diagnostic-only control. It is injected through the existing
`ReviewProvider` seam by an eval-only command, but is not available to production routing,
baseline calculation, or promotion metrics. Before any conclusion is drawn from it,
archive two immutable controls for `auth-guard-bypass`:

1. **Descriptor replay:** the exact rendered MatrixCore work-item prompt, response schema, and
   frozen work-item context for each relevant local/interaction task.
2. **Fixture replay:** the frozen diff and supplied `Session` context with a neutral review
   instruction and the same candidate schema.

Each artifact records the model identifier, timestamp, snapshot/diff hash, complete
model-visible prompt, schema, raw final response, parsed candidate output, and strict plus
substantive evaluation. Do not request or persist private chain-of-thought. The control is
interpreted only as follows: descriptor success means the bounded task contains sufficient
evidence for a stronger model; fixture-only success identifies task representation as the
remaining bottleneck.

### Responses API diagnostic implementation

`npm run eval:small-model-path:sota-control` injects an `OpenAIResponsesProvider` through the ordinary candidate,
evidence, verifier, and strict-oracle stages. It uses `gpt-5.6-luna`, `reasoning.effort: high`,
strict JSON-schema output, and the existing work-item budgets. It archives an opt-in reasoning
summary only; raw chain-of-thought is neither requested nor retained. The provider remains
unavailable to normal policy configuration.

Run `npm run eval:small-model-path:sota-control -- --prepare-subagent` first to freeze the descriptor and create
the one-off Codex-subagent prompt. Then run the Responses control with `OPENAI_API_KEY`; its
three repetitions and HTML/JSON evidence are stored beneath `.quality/evals/sota-controls/`.

### Implemented 4B treatment

`vllm-metal-thinking-4b-control-flow-delta` is an opt-in treatment identical to
`vllm-metal-thinking-4b` except for a host-derived `controlFlowDelta` task field. It does not add
a model call, a security rule, a specialist lens, or a repository-specific signal registry.

For TypeScript only, the host compares an edited old/new `if` guard when all of the following are
true:

- the guard blocks via `throw` or `return`;
- expressions are side-effect-free boolean compositions of `!`, `&&`, `||`, strict equality,
  identifiers, and safe member reads;
- the necessary values are explicitly nullable or finite literal-union values in the frozen
  visible source; and
- the changed guard line is visible in the candidate prompt.

The host emits only mechanically proven changed states, bounded to two entries and 96 estimated
tokens. It never claims a policy, severity, category, or defect. Unsupported or uncertain
expressions emit no delta. The delta is included in the work-item prompt and shadow descriptor,
so descriptor identity, trace provenance, and cache identity change deterministically.

### Rule-bound classification treatment

The `vllm-metal-thinking-4b-rule-bound-classification` treatment is a targeted follow-up to the
control-flow-delta experiment. It preserves matched rules with declared severity under the existing
per-work-item rule cap, requires each candidate to name a visible `basisRuleId`, and derives only a
selected rule's singleton category and declared severity in host code. It does not infer policy from
keywords, change strict oracle semantics, add a call, or alter evidence selection. The auth target
is a candidate-stage hypothesis: a demonstrated authorization bypass bound to
`security.authorization-boundary` receives `security` / `critical`; verification remains an
independent evidence-stage concern.

The auth delta is:

```text
session present, role = "member": previous guard blocked; current guard passes
```

### Evaluation gate

### 4B A-derived prompt screen — 2026-10-18

This diagnostic tested three prompt-only descendants of the existing A state-scan prompt on the
frozen `auth-guard-bypass` task. Every run used the 4B vLLM-Metal server, rule-bound
classification, control-flow delta, 4,096 context, 1,895 maximum output tokens, a 1,024-token
hard reasoning budget, temperature `0.6`, top-p `0.95`, top-k `20`, and the unchanged schema,
verifier, and work-item selection. The variants were not production defaults.

| Arm | One-repeat result | Three-repeat result | Decision |
| --- | --- | --- | --- |
| A state scan | completed; no substantive recognition | 0 strict recall; substantive completed-call recognition 16.7%; 109.6s mean | Control retained only as diagnostic reference. |
| Rule/outcome witness | partial; provider failure after three calls | not advanced | Reject: reliability gate failed. |
| Rule counterfactual | partial; provider failure after two calls | not advanced | Reject: reliability gate failed. |
| Finite truth table | strict and substantive candidate match 1.0 | 0 strict recall; substantive completed-call recognition 16.7%; 111.9s mean | Reject: one-run success did not reproduce. |

The finite truth-table trace found the correct member-session state in one screen run, but its
three matched repetitions emitted `no_finding` twice and one generic authorization candidate
once. Its aggregate substantive recognition exactly matched A while using more calls and latency.
The prompt did not consistently preserve the decisive state through final candidate generation.

Artifacts:

- [A screen HTML](../.quality/evals/4b-prompt-screen-a-state-scan-r1.html) and [finite-table screen HTML](../.quality/evals/4b-prompt-screen-finite-truth-table-r1-retry1.html)
- [A three-repeat HTML](../.quality/evals/4b-prompt-gate-a-state-scan-r3.html) and [finite-table three-repeat HTML](../.quality/evals/4b-prompt-gate-finite-truth-table-r3.html)

The experimental variants were removed after the failed gate. No production candidate prompt,
baseline, strict oracle, model budget, or server setting changed. The next investigation must
address the observed 4B reasoning/final-decision instability rather than extend this prompt family.

### State-scan reasoning-budget diagnostic (pending)

The A prompt (`branch-analysis-state-scan-v2`) is retained as an efficiency hypothesis: its
one-repeat auth run completed without a schema failure and used less latency/output than the
earlier `branch-analysis-v1` control, but did not improve auth recall. It is not yet a selected
default. The next matched experiment runs three repetitions per arm, in this order:

| Arm | Named treatment | Total candidate output | Hard reasoning budget | Isolated question |
| --- | --- | ---: | ---: | --- |
| A | `vllm-metal-thinking-4b-rule-bound-state-scan` | 1,024 | 512 | State-scan efficiency control. |
| B | `vllm-metal-thinking-4b-rule-bound-state-scan-output-max-fit` | 1,895 | 512 | Is final content/total-output headroom limiting the result? |
| C | `vllm-metal-thinking-4b-rule-bound-state-scan-output-max-fit-thinking-1k` | 1,895 | 1,024 | Is the hard reasoning budget itself limiting the result? |

An attempted literal 2,048-token B arm was rejected before inference: with the fixed 4,096-token
context and 1,000-token safety reserve it leaves only 1,048 input tokens, below the hard
1,200-token partitioned-route minimum. The 1,895-token maximum-fit arms leave 1,201 input tokens;
the largest A-arm candidate prompt was 1,135 tokens, so it also fits the provider's exact check.
All other inputs are fixed: 4B checkpoint, 4,096-token server context, temperature `0.6`,
top-p `0.95`, top-k `20`, rule-bound classification, control-flow delta, candidate schema,
and frozen `auth-guard-bypass` task. A subsequent three-repeat Luna control uses arm A's exact
prompt variant and candidate contract. The matched-model comparison rejects a result unless the
local `deleteUser` task's prompt hash, system-prompt hash, and canonical candidate-schema hash
are byte-identical across 4B and Luna. It retains raw 4B thinking, Luna's permitted reasoning
summary, final JSON, completion data, and token counts; neither control is promotion evidence.

Run a fresh three-repetition 4B control followed by three matched treatment repetitions on only
`auth-guard-bypass`, after the 4B vLLM contract probe is healthy. Persist prompts, reasoning and
content token counts, final structured responses, traces, strict metrics, substantive diagnostics,
latency, calls, partials, and failures.

The targeted treatment advances to a full-suite smoke run only when all three repetitions
complete without provider/schema/timeout/partial failures; strict auth candidate recall is `1/1`
in every repetition; strict precision does not regress; calls and hard output/evidence budgets are
unchanged; and added input remains within the 96-token delta cap and a 10% total-input increase.
The full suite remains a separate three-repetition gate. Neither the SOTA control nor this
diagnostic treatment replaces the promoted host-default baseline automatically.

### Delta-first bounded-reasoning experiment (R1 gate failed)

The preceding traces narrow the next hypothesis. The 4B model can evaluate the decisive
member-session state and can emit the correct authorization candidate, but under the fixed hard
reasoning budget it sometimes spends tokens restating the task, repeatedly analyzes the null
state, or reaches the decisive supplied delta only near the forced reasoning terminator. The next
experiment changes reasoning order rather than model capacity, schema, or policy: evaluate the
host-derived delta first, make an immediate decision when that concrete state violates a visible
rule, and otherwise continue the bounded state scan. The delta remains evidence to evaluate, not
proof of a defect.

The existing state-scan control paragraph remains unchanged:

```text
Use a compact state scan, not a narrative explanation. For every changed condition with a finite state space, enumerate each relevant state exactly once, internally recording: state → operands in source order → short-circuit result → observable outcome. Do not restate the task, source code, types, rules, or a state already evaluated. Do not reconsider a completed state.
```

The treatment replaces only that paragraph with:

```text
Use a delta-first compact state scan, not a narrative explanation. When the work item supplies a host-derived control-flow delta state, evaluate that state before any other runtime state, internally recording: state → operands in source order → short-circuit result → observable outcome → applicable visible rule. Do not restate the task, source code, types, rules, or delta. If the evaluated state demonstrates a visible-rule violation, form the candidate decision immediately; otherwise evaluate each remaining relevant state exactly once. Treat the delta as evidence to evaluate, not proof of a defect, and do not reconsider a completed state.
```

The matched arms are:

| Arm | Named treatment | Prompt variant |
| --- | --- | --- |
| Control | `vllm-metal-thinking-4b-rule-bound-state-scan-output-max-fit-thinking-1k` | `branch-analysis-state-scan-v2` |
| Treatment | `vllm-metal-thinking-4b-rule-bound-delta-first-output-max-fit-thinking-1k` | `branch-analysis-delta-first-v3` |

Everything else is frozen: `mlx-community/Qwen3.5-4B-MLX-4bit`, vLLM-Metal, 4,096-token
context, 1,895 total candidate-output tokens, 1,024 hard reasoning tokens, temperature `0.6`,
top-p `0.95`, top-k `20`, rule-bound classification, thinking plus structured output,
control-flow-delta input, provider timeout, candidate schema, verifier, work-item selection, and
hard call/token budgets. The failed local 9B feasibility treatments are not part of this test.

Run one matched repetition of `auth-guard-bypass` first and inspect both traces. Record delta
evaluation position, pre-delta task/source restatement, repeated-state count, short-circuit
correctness, final JSON, reasoning/output tokens, latency, completion state, strict metrics, and
substantive diagnostics. Advance to three matched repetitions only if the treatment completes and
its interaction candidate identifies the supplied member-session bypass without a new provider,
schema, timeout, or partial failure.

The targeted gate passes only when all three treatment repetitions:

- complete within the unchanged hard budgets and call count;
- evaluate the supplied delta state first without pre-delta task/source restatement;
- do not reconsider a completed runtime state;
- produce the correct auth interaction candidate, with strict candidate recall `1/1` per repetition;
- preserve or improve strict precision, verified metrics, partial rate, timeout rate, and provider-failure rate relative to the matched control; and
- do not turn a negative delta case into a finding merely because a delta was supplied.

Only after that targeted gate may the treatment run against all applicable delta fixtures and then
the full component suite. Those later gates must retain strict oracle semantics and show no
regression in recall, precision, verified recall/precision, calls, tokens, latency, or reliability.
This diagnostic does not update a baseline or production default automatically.

An initial R1 attempt was invalid because the server command loaded the unpatched Homebrew
`vllm_metal` package rather than the patched checkout. Those artifacts are retained for audit only:

| Arm | Case result | Interaction reasoning | Final content | Interpretation |
| --- | --- | --- | --- | --- |
| State-scan control | `error` | Correctly identified the member-session authorization bypass, but consumed all 1,895 output tokens | none | Invalid quality result: requested 1,024-token reasoning budget was not enforced. |
| Delta-first treatment | `error` | Evaluated the supplied member delta first and identified the same bypass, but still restated the task and continued reasoning | none | Hypothesis partly visible in the trace, but the completion contract failed before candidate serialization. |

Artifacts: [control HTML](../.quality/evals/4b-delta-first-control-r1.html),
[control JSON](../.quality/evals/4b-delta-first-control-r1.json),
[treatment HTML](../.quality/evals/4b-delta-first-treatment-r1.html), and
[treatment JSON](../.quality/evals/4b-delta-first-treatment-r1.json).

In both invalid interaction calls, provider usage reported `reasoningTokens = 1,895`,
`finalContentTokens = 0`, and `doneReason = length`. This did not demonstrate a defect in commit
`4edcb4d`; the launch omitted `PYTHONPATH=/private/tmp/vllm-metal-thinking-budget` and therefore
used the unpatched Homebrew sampling path.

The corrected launch loaded the patched checkout. The direct contract probe then passed all four
combinations. Its thinking-plus-schema probe produced valid structured content, stopped normally,
and reported 1,036 reasoning tokens: the requested 1,024-token budget plus the 12-token forced
closing sequence. Artifact: [patched contract probe JSON](../.quality/evals/vllm-contract-probe-patched-4b-1k.json).

The corrected matched R1 result was:

| Metric | State-scan control | Delta-first treatment |
| --- | ---: | ---: |
| Execution | completed | completed |
| Eval status | fail | fail |
| Provider/schema failures | 0 | 0 |
| Strict candidate recall | 0/1 | 0/1 |
| Substantive case capability | 0/1 | 0/1 |
| Substantive completed-call recognition | 0/2 | 0/2 |
| Duration | 113.6 s | 105.7 s |
| Interaction reasoning tokens | 875 | 1,036 |
| Interaction final response | `no_finding` | `no_finding` |

Artifacts: [corrected control HTML](../.quality/evals/4b-delta-first-control-patched-r1.html),
[corrected control JSON](../.quality/evals/4b-delta-first-control-patched-r1.json),
[corrected treatment HTML](../.quality/evals/4b-delta-first-treatment-patched-r1.html), and
[corrected treatment JSON](../.quality/evals/4b-delta-first-treatment-patched-r1.json).

The corrected traces show a reasoning-to-decision failure, not an infrastructure failure. Both
interaction traces correctly derived that a present member session short-circuits the guard and
reaches deletion. The control nevertheless serialized `no_finding`. The treatment also serialized
`no_finding`; it still began by restating instructions and context, and it did not form the required
candidate immediately after deriving the visible-rule violation. The control's local call emitted
a security candidate, but its trigger incorrectly named a missing role or admin role and therefore
failed both strict and substantive matching. The treatment's local call emitted `no_finding`.

The treatment therefore fails the R1 advancement gate and must not proceed to three repetitions.
The delta-first paragraph did not improve strict recall, substantive recognition, or final-decision
preservation. It reduced observed wall time by about 7.8 seconds, but that efficiency difference is
not promotion evidence in the absence of a quality improvement.

### Two-thousand-token reasoning sensitivity diagnostic

One additional R1 diagnostic isolated whether the 1,024-token reasoning ceiling was preventing the
delta-first treatment from reaching and preserving a decision. This was not an advancement run and
does not supersede the failed matched gate above. It used the same 4B model, temperature `0.6`,
top-p `0.95`, top-k `20`, rule-bound candidate arm, delta-first prompt, and structured-thinking
path, but increased the server context to 6,144 tokens, candidate output budget to 3,072 tokens,
hard reasoning budget to 2,048 tokens, and provider timeout to 900 seconds. The server loaded the
patched checkout through `PYTHONPATH=/private/tmp/vllm-metal-thinking-budget`.

| Metric | Two-thousand-token diagnostic |
| --- | ---: |
| Execution | completed |
| Eval status | fail |
| Provider/schema failures | 0 |
| Partial/timeout rate | 0 |
| Relevant candidate calls returning `finding` | 2/2 |
| Stage-one candidate finding recall | 1/1 |
| Stage-one candidate finding precision | 1/2 |
| Strict expected-candidate recall | 0/1 |
| Substantive case capability | 0/1 |
| Verified finding recall | 0/1 |
| Model calls | 5 |
| Input/output tokens | 4,839 / 5,109 |
| Wall time | 258.5 s |

Artifacts: [HTML](../.quality/evals/4b-delta-first-thinking-2k-long-timeout-r1.html),
[JSON](../.quality/evals/4b-delta-first-thinking-2k-long-timeout-r1.json), and
[stream traces](../.quality/evals/traces/2026-10-19T04-34-04-920Z-a0d55eba-6023-4a66-a46d-3ca327b02ffd/).

The interaction call used 2,060 reasoning tokens (the requested 2,048 tokens plus the 12-token
forced closing sequence) and 145 final-content tokens. It correctly evaluated the supplied member
state, classified the result as a critical authorization-boundary finding, and emitted structured
content with `state: "finding"`. The broader local call behaved the same way. A third local call
that contained only the optional role assignment correctly returned `no_finding`.

This result rejects the narrow hypothesis that the model invariably loses a correct conclusion
when moving from thinking to structured content. Under the larger budget, the relevant calls
preserved the decision. It supports a different diagnosis: the 1,024-token ceiling was too tight
for the current prompt and 4B model, while the remaining failure is in candidate fidelity and
verification. The interaction candidate used the rule identifier itself as its trigger; the local
candidate described the member state more directly, but the strict oracle still rejected its
invariant and impact wording. Both candidates were then rejected by the verifier, leaving verified
recall at zero despite stage-one candidate recall of one. The diagnostic matcher also reported
zero substantive recognition, which conflicts with the emitted local candidate's explicit member
trigger and must be investigated independently rather than treated as evidence that the model did
not understand the defect.

The larger budget is therefore diagnostic evidence, not a promotable default: it more than doubled
candidate-stage wall time and output-token use relative to the corrected 1,024-token R1 treatment.
The next iteration must separate (1) reasoning completion, (2) machine-checkable decision
commitment, (3) candidate-field fidelity, and (4) verifier correctness instead of collapsing all
four into final verified recall.

### Three-repetition 2,048-token check

The identical 2,048-token treatment was then run for three matched repetitions. The suite completed
all three repetitions with no provider failure, schema failure, partial result, or timeout. The
result was not quality-stable:

| Metric | R1 | R2 | R3 | Aggregate |
| --- | ---: | ---: | ---: | ---: |
| Execution | completed | completed | completed | 3/3 |
| Eval status | fail | fail | fail | fail |
| Stage-one candidate finding recall | 1/1 | 1/1 | 1/1 | 3/3 |
| Stage-one false-positive candidates | 1 | 1 | 0 | 2 |
| Strict expected-candidate recall | 0/1 | 1/1 | 0/1 | 1/3 |
| Substantive case capability | 0/1 | 0/1 | 1/1 | 1/3 |
| Verified finding recall | 0/1 | 0/1 | 0/1 | 0/3 |
| Provider/schema failures | 0 | 0 | 0 | 0 |
| Completed model calls | 5/5 | 5/5 | 4/4 | 14/14 |
| Input tokens | 4,839 | 4,881 | 3,982 | 13,702 |
| Output tokens | 5,109 | 6,704 | 3,422 | 15,235 |
| Duration | 1,020.0 s | 325.7 s | 167.6 s | mean 504.5 s |

Aggregate stage-one candidate precision was `0.60`; verified precision and recall were both zero.
Artifact: [R3 HTML](../.quality/evals/4b-delta-first-thinking-2k-long-timeout-r3.html),
[R3 JSON](../.quality/evals/4b-delta-first-thinking-2k-long-timeout-r3.json), and
[R3 stream traces](../.quality/evals/traces/2026-10-20T02-39-53-040Z-cddc1ccf-cec1-4be0-add4-d7c83910bceb/).

The interaction work item preserved the correct finding in R1 and R2. In R3, its reasoning trace
again explicitly concluded that the present member session bypasses the authorization guard, but
the final structured content was `{"state":"no_finding","candidates":[]}`. That call stopped
naturally after 731 reasoning tokens; it did not reach the hard 2,048-token boundary. Therefore,
raising the budget makes the correct single-call result possible but does not make decision
preservation reliable. A larger maximum cannot prevent a premature, contradictory final decision.

The broader local work item emitted a finding in all three repetitions, but its trigger, invariant,
impact, and line range varied enough that strict matching passed only once. The narrow role-only
work item correctly returned `no_finding` in all repetitions. All five emitted candidates across
the three repetitions were rejected by the verifier despite resolved evidence, so verifier behavior
is an independent zero-recall bottleneck.

R1 also experienced a host-side generation stall: the first candidate request remained live for
about 870 seconds before completing under the 900-second request timeout. R2 and R3 completed in
about 326 and 168 seconds respectively. This latency variance prevents promotion even though
provider-call completion was 100 percent.

The three-repetition result fails the advancement gate. It establishes three separate next targets:

1. Bind the final decision to a machine-checkable commitment so a reasoning trace that concludes
   `finding` cannot serialize `no_finding`.
2. Project canonical trigger, invariant, rule classification, and location from host-owned state and
   rule references so semantically identical findings do not depend on unstable prose.
3. Capture and diagnose verifier output because repeated evidence-backed candidates were rejected
   in every repetition.

### Ollama 9B bounded-thinking compatibility experiment

The Ollama follow-up tested whether the same hard reasoning transition could be used with the
larger `qwen3.5:9b-q4_K_M` GGUF model that fits this laptop. This is an isolated diagnostic path,
not a change to the Homebrew Ollama service or a promoted default.

The runtime was built from `mann1x/up-think-budget` at commit
`97c08679f338e6a8780dfce83131ebcb9915ca4a`. The branch exposes `think_budget` and
`think_budget_tokens`, but its bundled llama.cpp revision does not consume Ollama's
`generation_prompt` request field. Without that field the sampler never enters its budgeted
thinking state when the chat template has already emitted `<think>`. The isolated build therefore
requires a compatibility change in llama.cpp's `tools/server/server-schema.cpp` that reads
`generation_prompt` into `ctx.params.sampling.generation_prompt`. A native `/api/generate` probe
then showed the expected transition: the sampler activated with a 64-token reasoning budget,
forced the closing sequence when the budget was exhausted, and returned schema-valid JSON. This
compatibility change is not upstreamed or part of MatrixCore's shipped provider runtime, so the
Ollama treatment remains diagnostic-only.

The exact compatibility diff is preserved at
[`docs/patches/ollama-think-budget-generation-prompt.patch`](./patches/ollama-think-budget-generation-prompt.patch).
It applies inside the bundled llama.cpp checkout after Ollama's CMake configure step. The tested
runtime was built and served in isolation with:

```bash
git clone --branch mann1x/up-think-budget https://github.com/mann1x/ollama.git /private/tmp/ollama-think-budget
git -C /private/tmp/ollama-think-budget checkout 97c08679f338e6a8780dfce83131ebcb9915ca4a
cmake -S /private/tmp/ollama-think-budget -B /private/tmp/ollama-think-budget/build -DOLLAMA_MLX_BACKENDS:STRING=
git -C /private/tmp/ollama-think-budget/build/_deps/llama_cpp-src apply \
  /Users/ericsMac/Documents/MatrixCore/docs/patches/ollama-think-budget-generation-prompt.patch
cmake --build /private/tmp/ollama-think-budget/build --parallel 8
OLLAMA_HOST=127.0.0.1:11435 \
OLLAMA_FLASH_ATTENTION=1 \
OLLAMA_KV_CACHE_TYPE=q8_0 \
  /private/tmp/ollama-think-budget/ollama serve
```

MatrixCore now supports this contract without changing the ordinary Ollama path:

- bounded `thinking-structured` requests use `/api/generate`, including the system prompt, JSON
  schema, and `options.think_budget`;
- ordinary structured requests and unbounded thinking diagnostics retain their existing behavior;
- streamed `thinking` and `response` fields are recorded separately;
- applied `think_budget` and `think_budget_tokens` telemetry are preserved in completion metadata;
- native-schema candidate generation omits redundant JSON-syntax instructions; and
- the named treatment
  `ollama-thinking-9b-rule-bound-delta-first-output-3k-thinking-2k-long-timeout` freezes the 9B
  model, 6,144-token context, 3,072-token candidate output ceiling, 2,048-token reasoning budget,
  temperature `0.6`, top-p `0.95`, top-k `20`, 900-second timeout, rule-bound classification, and
  delta-first prompt.

The first `auth-guard-bypass` repetition produced the following result:

| Metric | Ollama 9B R1 |
| --- | ---: |
| Provider calls completed | 4/4 |
| Provider/schema failures | 0 |
| Timeouts | 0 |
| Selection recall | 1/1 |
| Candidate finding recall | 1/1 |
| Candidate finding precision | 1/1 |
| Strict expected-candidate recall | 0/1 |
| Substantive case capability | 1/1 |
| Substantive completed-call recognition | 1/3 |
| Substantive finding fidelity | 1/1 |
| Verified finding recall | 0/1 |
| Final finding recall | 0/1 |
| Input/output tokens | 4,040 / 4,559 |
| Model calls | 4 |
| Duration | 260.4 s |

Artifacts: [HTML](../.quality/evals/ollama-thinking-9b-rule-bound-delta-first-output-3k-thinking-2k-r1.html),
[JSON](../.quality/evals/ollama-thinking-9b-rule-bound-delta-first-output-3k-thinking-2k-r1.json),
and [stream traces](../.quality/evals/traces/2026-10-25T04-25-07-938Z-334912a9-1027-44a9-9dd8-f58dbb836760/).

The interaction call is a real model-quality improvement over the 4B diagnostic. Its reasoning
evaluated the present `member` session, applied `&&` short-circuiting, concluded that deletion was
reached, selected `security.authorization-boundary`, and emitted a critical security candidate at
`src/routes.ts:5`. The final candidate stated that member users can delete accounts without admin
privileges. The run therefore achieved 100 percent substantive case capability and finding
fidelity with no provider instability.

The run is still not promotable. Strict candidate matching rejected the correct candidate because
the generated trigger/invariant/impact did not preserve the literal required terms `&&` and
`deleteUser`; the candidate instead described the equivalent short-circuit state and deletion
impact. The verifier then rejected the candidate despite receiving and citing the changed
`deleteUser` implementation, the resolved `deleteUser` evidence, and the `Session` type showing
the `admin | member` role set. One narrow role-assignment work item also returned
`insufficient_context`, making execution honestly partial under the current contract. The next
bounded work must therefore diagnose strict semantic projection and verifier decision capture;
another provider experiment or a three-repetition promotion run is not justified yet.

### Ollama 9B five-repetition reproducibility result

The identical named Ollama 9B treatment was subsequently run for five repetitions without any
configuration override. The interaction work item identified the concrete member-session
authorization bypass in all five repetitions. Every interaction candidate selected
`src/routes.ts:5`, critical/security classification, the `member` runtime state, and the
`security.authorization-boundary` rule. This confirms that the 9B result was not a one-off model
success.

| Metric | Five-repetition result |
| --- | ---: |
| Interaction vulnerability recognition | 5/5 |
| Substantive case capability | 5/5 (100%) |
| Candidate finding recall | 5/5 (100%) |
| Candidate finding precision | 5/6 (83.3%) |
| Strict expected-candidate recall | 1/5 (20%) |
| Substantive completed-call recognition | 7/15 (46.7%) |
| Substantive finding fidelity | 7/8 (87.5%) |
| Verified finding recall | 0/5 |
| Final finding recall | 0/5 |
| Provider failures / errors / timeouts | 0 / 0 / 0 |
| Execution partial rate | 2/5 (40%) |
| Structured repairs | 2 |
| Model calls | 21 |
| Input/output tokens | 21,802 / 27,046 |
| Mean wall time | 297.3 s |

Artifacts: [HTML](../.quality/evals/ollama-thinking-9b-rule-bound-delta-first-output-3k-thinking-2k-r5.html),
[JSON](../.quality/evals/ollama-thinking-9b-rule-bound-delta-first-output-3k-thinking-2k-r5.json),
and [stream traces](../.quality/evals/traces/2026-10-25T04-45-08-327Z-34da9136-379e-42dd-b286-bdd3ee514e89/).

The hard-thinking provider contract was reliable across the run: all 15 candidate calls completed,
all reported the applied 2,048-token budget, and none failed schema validation or timed out. The
interaction call ended naturally below the cap once and otherwise used the cap before returning
valid structured content. The two partial repetitions came from the narrow role-assignment work
item returning `insufficient_context`, not from a provider failure.

The next hill-climb should not target vulnerability discovery. That capability is now reproducible
for this case. It should isolate three downstream contracts in order: (1) deterministic projection
of canonical operator, symbol, and rule terms into candidate fields; (2) verifier correctness for
an evidence-complete authorization bypass; and (3) treatment of intentionally narrow work items so
an honest `insufficient_context` does not obscure the successful interaction review. Strict oracle
semantics and hard budgets remain unchanged while these layers are diagnosed.
