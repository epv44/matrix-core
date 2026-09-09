# AgentSmith Eval Terminology

This document is the authoritative terminology contract for AgentSmith evals. New
code, tests, reports, baselines, and documentation must use these terms
consistently.

## Core terms

### Eval

An **eval** is one test case. It has a case definition, a fixture or replay
input, and the expected behavior or findings used to evaluate a run.

### Eval suite

An **eval suite** is a named collection of evals targeting one subject. The
suite name identifies the subject and is not a run mode, status, or model.

Examples include `component`, `conformance`, `component-sql`, and `e2e`.
Examples do not make a suite valid by themselves; a suite is valid only when
evals are assigned to it in the repository.

The current valid repository suites are:

- `component`
- `conformance`

`component-sql` is a future example, not a current repository suite. It must
not be treated as available until evals are explicitly assigned to it.

The existing `matrixcore-large-diff-clear` item is a **draft eval** assigned to
the `component` suite. Its `draft` status keeps it out of active suite runs;
status does not create a separate draft suite or make the eval eligible for
promotion.

### Suite run

A **suite run** is one execution of exactly one named eval suite. Its output,
status, metrics, and baseline are scoped to that suite and the run's selected
configuration.

### Campaign

A **campaign** is a multi-suite execution. This term applies only if a
multi-suite command is introduced later. A suite run must not be called a
campaign, and a campaign must not be represented as a suite name.

### Case lifecycle status

An eval case's lifecycle status is one of:

- `active`: eligible for normal suite execution;
- `draft`: still being curated or reviewed and not eligible for normal suite
  execution.

`draft` is a case lifecycle status, never an eval suite name. A draft eval must not be
included in active-suite results or promoted as an active eval merely because
it appears in the repository.

### Execution status

`executionStatus` describes whether the scheduled review work completed. It
uses runtime states such as `completed`, `partial`, `error`, or `stale` and
does not express whether an oracle was satisfied. A completed verifier
abstention remains `completed`; timeout, provider failure, or inability to run
required verification work is partial or error as appropriate.

### Eval result status

`evalStatus` compares applicable outputs with the fixture oracle:

- `pass`: every applicable oracle reached its required disposition;
- `fail`: a definitive wrong result was produced or an expected candidate was
  missed;
- `partial`: the relevant candidate entered the pipeline but did not reach the
  required terminal disposition.

Definitive failures take precedence over unrelated unresolved candidates.
This status is separate from both case lifecycle status and execution status.

### Candidate resolution

`candidateResolution` is `proven`, `disproven`, `unproven`, or `missed`.
Reports also record the expected disposition, whether the oracle was
satisfied, and a typed root-cause attribution. Candidate recall, verified
recall, and final finding recall remain separate measurements.

### Stage applicability

An intentionally unlabelled stage is `not-applicable` and renders as `N/A`.
It is excluded from status and metric denominators. `not-evaluable` means the
fixture declared an applicable stage contract but the evaluator could not
execute it; only that state can contribute to incompleteness.

### Replay tier

A **replay tier** identifies how an eval run obtains and executes its inputs:

- `stage`
- `recorded`
- `isolated`
- `live`

Replay tier is distinct from suite, eval status, and model target.

### Model target

A **model target** selects the intended review path:

- `small`
- `large`

Model target is distinct from the configured provider model, replay tier, and
suite name.

## Approved CLI vocabulary

The public AgentSmith entrypoint uses the shared eval command with an explicit
target and one suite:

```bash
npm run eval -- \
  --target agentsmith \
  --suite component-sql \
  --model small \
  --format html \
  --output .quality/evals/latest.html \
  --create-baseline evals/agentsmith/baselines/component-sql-small.json
```

The command vocabulary is:

- `--target agentsmith`: selects the AgentSmith evaluator;
- `--suite <suite-name>`: selects exactly one registered eval suite;
- `--model small|large`: selects the model target;
- `--format text|json|html`: selects the report format;
- `--output <path>`: selects the report output path;
- `--baseline <path>`: compares the run with an existing baseline;
- `--create-baseline <path>`: creates an observational baseline from a
  structurally complete suite run. The baseline records quality and
  completeness evidence but does not contain or make a promotion decision.

The model target defaults to `small` when omitted. `--suite` names a suite,
not a collection of all suites, and `draft` is invalid as a suite name.
`component-sql` in the example illustrates the naming convention; it is not a
claim that the current repository provides that suite.

The legacy command form
`npm run eval:agentsmith -- suite ...` is not the approved final vocabulary
and is removed when the CLI migration is complete.

## Model routing convention

The `small` model target uses the bounded small-model review path:

- graph-selected, risk-ranked review units;
- partitioned review tasks;
- bounded supporting context and hard work/token budgets.

The `large` model target uses the broad review path:

- broad or full projection of the change and relevant context;
- holistic review;
- broad specialist behavior where configured.

A `large` run requires a configured and available large-model profile. If the
large target is unavailable, the run must fail clearly before producing a
report or baseline; it must never silently fall back to `small`.

Model routing must not change the meaning of suite, eval status, replay tier,
or campaign.
