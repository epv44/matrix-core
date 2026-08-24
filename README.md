# MatrixCore - Language Agnostic

Core-first quality engine with a universal local MCP tool interface and native host
completion hooks. The engine owns validation, review, artifacts, and policy.

```
matrix-core
├── core/
│   ├── runner, gate (terminal PASS/FAIL plus separate active-run state), version, gate-store, reviewer, cli
├── agentsmith/
│   ├── four strong-model specialist prompts, structured rules, generic small-model engine, verifier
├── packs/
│   ├── python/ centrally configured ruff, ruff-format, mypy, xenon, deptry
│   ├── sql/ centrally configured sqlfluff plus embedded-Python extraction
│   └── typescript/ centrally configured tsc, eslint
├── policy/ (embedded defaults plus the GitHub bundle contract schema)
├── mcp/ (quality_run, quality_status, quality_fix over local stdio)
├── hooks/ (shared completion policy + host response envelopes)
└── integrations/ (Codex, Claude Code, and Cline native configuration)
```

**Status matrix:** PluginResult `PASS|FAIL|SKIPPED|ERROR`
- SKIPPED = env limitation not code defect
- FAIL = code violates or required binary missing
- ERROR = engine malfunction
- PASS = ok

**Gate model:** deterministic runs record schema-v2 evidence containing execution mode,
fast/full semantics, base branch, and changed-file scope. Changed feedback is stored in
`.quality/changed-gate.json`; full evidence is stored in `.quality/completion-gate.json`.
Native completion hooks never run the engine and accept only a current, non-fast full PASS.
Starting another completion run does not overwrite terminal evidence with `RUNNING`; completion
calls are serialized per repository and active-run state is stored separately.

## Build
```bash
npm install
npm run build
node dist/core/cli.js doctor
node dist/core/cli.js run
```

Public project installation uses the published package:

```bash
npm install --save-dev --save-exact @epv44/matrixcore@0.5.1
npx --no-install matrix-core doctor
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) for the shared holistic, partitioned, and hybrid review
pipeline.

## Config resolution (monorepo)
flag `--config` > CWD `quality.yaml` > parents upward > `.git` root > default embedded, nearest wins.

## quality.yaml template

```yaml
version: 2
project: my-application
review:
  agentsmith: true
```

Advisory review bounds are configurable. Defaults are conservative for slow local models: one
in-flight model call (`parallelism: 1`), four partitioned candidate work items, four verifier
candidates, and a total review deadline of `180000ms`. Faster providers can raise caps:

```yaml
review:
  agentsmith: true
  parallelism: 4
  maxDurationMs: 1800000
```

Timeout and token-budget results are explicit partial reviews, never approval. See
[ARCHITECTURE.md](ARCHITECTURE.md) and [src/agentsmith/README.md](src/agentsmith/README.md).

SQLite applications with SQL embedded in Python declare application-resolution metadata without
selecting quality rules:

```yaml
application:
  sql:
    - root: finance
      dialect: sqlite
      templater: raw
      sources: [files, python]
```

The v2 manifest is intentionally strict. By default, projects may opt into AgentSmith but use MatrixCore's
immutable embedded policy. A project may instead select one complete declarative policy bundle from a public
GitHub repository; it cannot inject commands or executable policy code. See [POLICY_BUNDLES.md](POLICY_BUNDLES.md).
V1 manifests are rejected with migration guidance.

## CLI
```bash
quality doctor
quality run --full
quality run --changed --base main
quality run --json
quality status --json
quality review --json
quality workspace show --json
quality policy show --json
quality policy status --json
quality policy sync
quality policy sync --locked
quality fix --review-version <version> --finding <id...>
quality trace status
quality eval list
quality config show
```

## Local AgentSmith traces and evals

AgentSmith tracing is a local diagnostic feature, not telemetry. It captures locally by default,
retaining the newest 20 traces within a 250 MiB budget. MatrixCore contains no trace uploader or
analytics endpoint. Disable capture explicitly with `MATRIXCORE_TRACE=off`; use
`MATRIXCORE_TRACE=agentsmith` to label a run as explicitly captured:

```bash
MATRIXCORE_TRACE=agentsmith quality completion
quality trace status
quality trace list
quality trace show <trace-id>
quality trace metrics <trace-id>
```

Enabled traces are private local files under `.quality/traces/agentsmith/`. They contain the frozen
snapshot, route decision, projection audits, work items, exact prompts and raw provider responses,
evidence resolution, verification, coverage, and decision provenance. `quality doctor`
warns when tracing is enabled and `.quality/` is not ignored by Git. Trace write failures never change
the review or completion decision.

Promote a deliberately selected trace into an editable regression case, label expected bugs L0-L3,
then compare candidate-generation strategies against the same frozen snapshot:

```bash
quality eval curate --trace <trace-id> --case <slug>
quality eval run --case <slug> --mode all --replay planner
quality eval run --case <slug> --mode all --replay recorded
quality eval run --case <slug> --mode all --replay live
quality eval compare <baseline-result.json> <current-result.json>
```

Curated cases are written to `evals/agentsmith/<slug>/`. Inspect `input.json` and `case.yaml` for
proprietary code, credentials, prompts, and personal data before committing them. Eval reports remain
ignored under `.quality/evals/runs/`. No trace is ever curated, committed, or transmitted automatically.
Curated `originalCandidates` can be labeled accepted or rejected, and
`expectedInspectionTargets` can name files, symbols, and graph edges that a sound planner must inspect.
Planner replay measures deterministic selection and coverage without an LLM. Recorded replay requires
exact prompt/model matches and detects strategy drift; live replay measures the complete current stack.
Reports include finding quality only when it is evaluable, plus file/changed-line coverage, target
recall, candidate adjudication, evidence relevance, reliability, latency, token use, and explicit
honesty checks. Rejected candidates must never become verified findings; likely, rejected, and
insufficient-evidence outcomes remain trace/eval data only.

## Deterministic profiles

- Python: Ruff lint, Ruff format check, mypy, Xenon with B/B/A limits, and deptry DEP004.
- SQL: SQLFluff using MatrixCore's bundled rules. Declared Python facets extract DB-API SQL literals,
  constants, and static concatenations; unresolved executed SQL fails closed.
- TypeScript: `tsc --noEmit` with MatrixCore quality overrides and ESLint using MatrixCore's bundled flat config.

The default embedded policy requires Ruff 0.16.1, mypy 2.3.0, Xenon 0.9.3, deptry 0.25.1,
SQLFluff 4.2.2, TypeScript 5.9.3, and ESLint 9.39.5 exactly. Consumers provision applicable
binaries in their designated workspace environments.

Application tests, coverage, builds, and application-specific validation are not part of the consumer
gate. Required tools must come from the resolved workspace environment and satisfy the central version
policy; missing or incompatible tools fail closed.

## Universal agent integration

Install MatrixCore in the project so its CLI, MCP server, and hook executable are available to local package resolution:

```bash
npm install --save-dev --save-exact @epv44/matrixcore@0.5.1
```

All hosts receive `quality_run`, `quality_status`, and `quality_fix` from the same local
stdio MCP server. Codex and Claude Code plugins bundle native Stop hooks; Cline uses
its native TaskComplete hook. The supplied integrations invoke the local package with
`npx --no-install`, which never downloads a missing package. See `integrations/README.md`
and `INSTALL_CLINE.md`.

Planning-only host turns bypass completion enforcement before workspace resolution. Default/code
mode remains fail-closed.

`quality_run(mode=completion)` runs MatrixCore's deterministic profile, then runs MatrixCore's
AgentSmith profile only when the project opts in. Application test policy remains independent.
`quality_fix` hands a version-bound repair task to the active Cline, Codex, or Claude Code
model. Ollama reviews code but never authors fixes.

### Select a review model

The embedded policy approves role-specific local profiles. Projects select role bindings by profile ID;
arbitrary model names are rejected:

```yaml
review:
  agentsmith: true
  mode: auto
  models:
    candidate: qwen35-9b-local
    scout: qwen35-122b-scout-local
    verifier: qwen35-9b-verifier-local
```

This is the recommended hybrid configuration. Use `qwen35-122b-local` as `candidate` for
four-specialist review when the complete projection fits. Small candidates and oversized strong-model
projections use the generic bounded engine. Install selected models explicitly:

```bash
ollama pull qwen3.5:9b-q4_K_M
ollama pull qwen3.5:122b-a10b
```

MatrixCore does not download models during installation or review.

Project setup (git init, .gitignore, quality.yaml, engine verify) is project-agnostic — see
`INSTALL_PROJECT.md`.

During plugin development, run `npm run plugin:sync` after changing the Codex manifest, skill,
hook, or MCP configuration. The command derives the plugin base version from `package.json` and
records a new immutable cachebuster. `npm pack` runs `plugin:check` and fails if the versions or
plugin fingerprint have diverged.

## Doctor example
```
[core] node ✓, git ✓
[python:.] python ✓, ruff ✓, mypy ✓, xenon ✓, deptry ✓
[sql:finance] python ✓, sqlfluff ✓
[typescript:frontend] node ✓, tsc ✓, eslint ✓
Doctor: PASSED
```

## Ignore
```
.quality/
coverage.json
coverage.xml
.coverage
.mypy_cache/
.ruff_cache/
.pytest_cache/
__pycache__/
*.pyc
.env
.DS_Store
dist/
node_modules/
```
