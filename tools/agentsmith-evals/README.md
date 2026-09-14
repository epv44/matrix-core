# AgentSmith diagnostic eval lab

This repository-only tool turns sanitized AgentSmith traces and frozen repositories into stage-level
diagnostics. It is intentionally excluded from the MatrixCore npm package and never runs as a quality
or release gate.

Each active case owns a content manifest and an immutable repository fixture with
`.matrixcore-ignore` boundary markers at the fixture container and replay-repository root. Validation rejects missing, extra, modified, executable-bit-drifted, or
unsafe-symlinked fixture entries. Every iteration materializes that fixture into a fresh temporary Git
repository, runs there, and deletes it; canonical fixtures never receive `.git`, graph databases, caches,
or other runtime state. A minimal package manifest is added only to temporary synthetic replays whose
fixture does not own one; real captured repositories retain their frozen package metadata.

Run one registered suite with the new public entrypoint. `component` and `conformance` are currently
registered; `component-sql`, `e2e`, and other names are rejected until active eval cases are assigned
to them. `small` is the default and runs bounded `partitioned-interactions`; `large` runs holistic
review and requires an approved, installed strong model. A missing large profile/model fails before
the run creates status, report, or baseline artifacts and never falls back to small.

```bash
npm run eval -- --target agentsmith --suite component --model small --format html \
  --output .quality/evals/latest.html \
  --create-baseline evals/agentsmith/baselines/component-small-host-defaults.json
npm run eval -- --target agentsmith --suite conformance --model large --format json
```

Reports, status records, and baselines identify the suite and model target. A baseline is an
observational measurement artifact: it may retain passing, failing, or partial quality scores, but
requires a structurally complete and deterministic-enough suite run. It contains no promotion
decision. The public suite entrypoint is the root `eval` command; it requires an explicit target
and registered suite.

```bash
npm run eval -- inventory
npm run eval -- validate
npm run eval -- coverage
npm run eval -- run --tier stage --label before
npm run eval -- run --tier recorded
npm run eval -- run --tier isolated
npm run eval -- run --tier live --repeat 3
npm run eval -- compare <baseline-result.json> <current-result.json>
npm run eval -- status
npm run eval -- status <run-id> --json
```

The root suite command runs one registered suite for the selected model target. `--format` accepts
`text`, `json`, or `html` (text is the default). HTML output always writes a neighboring JSON artifact.

Schema-v5 traces include a content-addressed source snapshot, so curation can copy a fixture directly
from the trace repository even when the eval lab lives elsewhere:

```bash
npm run eval -- curate --trace <trace-id> --trace-root <producer-repo> --case <slug> --project <name>
```

For a legacy trace, provide the still-matching repository with `--repo <path>`, or create the draft
without a fixture and later run `attach-fixture --case <slug> --repo <path>`. Fixtureless drafts cannot
run or become active.

New cases are drafts with no inferred ground truth. Review `input.json`, the copied fixture, and
`case.yaml`; label only independently known behavior; complete the sanitization attestations; then mark
the case active. Missing stage labels are explicitly `not-applicable` and render as `N/A`; they are
excluded from stage status, case status, and metric denominators. `not-evaluable` is reserved for a
declared, applicable contract that could not be executed. Replay freezes repository inputs but intentionally
uses the current MatrixCore engine, policy assets, prompts, graph providers, and model profiles. Reports
record their versions and hashes alongside the fixture digest. Recorded prompt drift is reported as
incompatible, not as a quality regression. Result files are written beneath `.quality/evals/runs/`;
Registered suite runs also write an atomically-updated status record beneath
`.quality/evals/suites/<run-id>/status.json`. The suite prints its run ID and progress as it executes,
and `status` can inspect that record from another terminal.

Schema-v6 cases add explicit human-review provenance, optional planning targets, and an optional
digest-bound `stage-replay.json`. The `isolated` tier measures candidate generation from the ordinary
pipeline while replaying evidence, verification, aggregation, and reporting from reviewed golden
candidates. This prevents an upstream candidate miss from being counted as a downstream failure.
Blocked downstream metrics remain visible on individual runs but are excluded from aggregate stage
means.

Cases may independently label eleven stages: snapshot, graph retrieval, planning, ranking, selection,
projection, candidate generation, evidence resolution, verification, aggregation, and reporting. A case
does not need to cover every stage. Graph labels are evaluated against the canonical graph manifest;
Planning, Ranking, and Selection use their own frozen inputs when supplied. Projection labels can require
exact source anchors and mark lockfiles or generated context as forbidden noise. Candidate and verifier
labels can require or forbid reasoning terms, while final findings match severity, category, title,
location, and evidence.

Schema-v3 suite reports separate `executionStatus` (whether scheduled work completed), `evalStatus`
(whether the oracle contract passed, failed, or remained unresolved), and `candidateResolution`
(`proven`, `disproven`, `unproven`, or `missed`). Intentional N/A stages never create a partial result.
A completed verifier abstention is `executionStatus: completed` and may be `evalStatus: partial` with an
`unproven` resolution. A missing expected candidate is `FAIL/MISSED`, even if an unrelated candidate is
unproven. Baseline creation is observational and never performs or reports a promotion decision;
promotion is checked separately with `./scripts/check-review-promotion stage-4 --baseline ... --current ...`.

Sensitive-content exemptions are intentionally narrow. Each exemption names the scanner pattern and a
case-relative file whose exact SHA-256 was reviewed. Validation rejects changed, duplicate, unused, or
unsafe exemptions and continues to reject every unrecognized match.
