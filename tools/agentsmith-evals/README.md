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

```bash
npm run eval:agentsmith -- inventory
npm run eval:agentsmith -- validate
npm run eval:agentsmith -- coverage
npm run eval:agentsmith -- run --tier stage --label before
npm run eval:agentsmith -- run --tier recorded
npm run eval:agentsmith -- run --tier live --repeat 3
npm run eval:agentsmith -- compare <baseline-result.json> <current-result.json>
```

Schema-v5 traces include a content-addressed source snapshot, so curation can copy a fixture directly
from the trace repository even when the eval lab lives elsewhere:

```bash
npm run eval:agentsmith -- curate --trace <trace-id> --trace-root <producer-repo> --case <slug> --project <name>
```

For a legacy trace, provide the still-matching repository with `--repo <path>`, or create the draft
without a fixture and later run `attach-fixture --case <slug> --repo <path>`. Fixtureless drafts cannot
run or become active.

New cases are drafts with no inferred ground truth. Review `input.json`, the copied fixture, and
`case.yaml`; label only independently known behavior; complete the sanitization attestations; then mark
the case active. Missing stage labels remain `N/A`. Replay freezes repository inputs but intentionally
uses the current MatrixCore engine, policy assets, prompts, graph providers, and model profiles. Reports
record their versions and hashes alongside the fixture digest. Recorded prompt drift is reported as
incompatible, not as a quality regression. Result files are written beneath `.quality/evals/runs/`.
