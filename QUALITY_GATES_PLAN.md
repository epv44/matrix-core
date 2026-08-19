# MatrixCore Quality Gates — Historical Plan

Status: historical reference. This document describes an earlier staged rollout and is not the
current CLI or AgentSmith architecture. For current behavior, see [ARCHITECTURE.md](ARCHITECTURE.md),
[INSTALL_PROJECT.md](INSTALL_PROJECT.md), and [USAGE.md](USAGE.md).

The current release uses `quality completion`, `quality review`, and the shared AgentSmith v2
pipeline. It does not provide the obsolete `quality judge`, `quality init-hooks`, or
`quality init-github` commands described below.

## Goal

Keep LLM feature dev speed while adding safety rails. One engine, three integration points
(agent loop, git, CI), shared config in `quality.yaml`.

```
LLM turn
   |
   | (afterTool hook)
   v
Fast Gate  (quality run --fast --changed)
   - formatting (ruff format --check / prettier)
   - syntax (ruff parse, tsc)
   - lint changed files (ruff, eslint)
   - type errors (mypy, tsc)
   - obvious violations (stage config)
   |
   v
Agent continues
   |
   | (afterRun / run_end hook)
   v
Full Gate  (quality run --full)
   - all tests (pytest, vitest, go test)
   - coverage (pytest-cov, baseline regression)
   - complexity (radon, eslint complexity)
   - duplication (jscpd)
   - architecture (dependency-cruiser / import rules)
   - security (bandit, npm audit, gitleaks)
   - regression checks (baseline diff)
   |
   v
LLM Judge  (quality judge --base main)  -> advisory local, blocking in CI
   |
   v
Ready for commit / PR
```

## Architecture decision: where things live

- **Logic + LLM judge live in MatrixCore.** The engine already owns changed-files, config,
  baseline, report, exit codes. The judge is a stage that consumes diff + full-gate report + rubric.
- **Git hooks are thin triggers, not logic.** `quality init-hooks` installs:
  - pre-commit -> fast gate (changed files)
  - pre-push -> full gate + judge (advisory; skips if no API key)
  Hooks are per-machine and bypassable (`--no-verify`); they are an early-signal layer.
- **GitHub Actions is the enforcement point.** `quality init-github` generates a workflow +
  composite action: `run --full` (blocking), `judge` (blocking status check), verdict posted as
  PR comment. Clean checkout + secrets + merge blocking live here.
- Same rubric everywhere -> consistent signal from agent loop, local push, and CI.

## Stage A — Fast/full gate stages (core)

- Config: `stages.fast.checks` list + optional per-check `fast` flag; backward compatible.
  Default fast set = lightweight deterministic subset (ruff, ruff-format, mypy, tsc, eslint).
- New `python.ruff-format` check (`ruff format --check`); new optional `typescript.prettier`.
- Wire existing `RunCtx.fast` into runner check selection; fast gate skips test/coverage/heavy packs.
- CLI: `quality run --fast [--changed]`; Cline tool `quality_run(mode=changed, fast=true)`.

## Stage B — Fill full-gate packs

- Real complexity: radon `cc` (python), eslint complexity / ts-complexity (typescript). Remove stubs.
- Duplication: jscpd (language-agnostic) -> metrics + policy.
- Architecture: dependency-cruiser (TS) / import rules (py), optional, allowlist-driven.
- Security: bandit (py), npm audit (ts), gitleaks (secrets), optional.
- All map to `PluginResult` + metrics so policies/baseline work unchanged.

## Stage C — LLM judge

- `quality judge [--base main] [--json]` command + `quality_run(mode=judge)` tool.
- Config block `judge: { enabled, blocking, provider, model, rubric, context_files }`.
- Inputs: git diff, full-gate report (JSON, so it never re-reviews linter findings), rubric, context.
- Output: `APPROVE | REQUEST_CHANGES | RISK`, findings with file:line, score, cache entry
  (hash of diff + config) to avoid re-judging unchanged PRs.
- Provider-agnostic client: OpenAI-compatible / Anthropic / local Ollama; key from env
  (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`). Structured-output parsing -> deterministic exit code.

## Stage D — Adapters (git + GitHub)

- Export `runGate({ mode })` programmatic API.
- `adapters/git/install-hooks.ts` (`quality init-hooks`): pre-commit fast, pre-push full+judge(advisory).
- `adapters/github/`: `action.yml` composite + `quality init-github` generator; PR workflow runs
  full gate + judge, posts comment, required-check config.
- Cline adapter: `run_end` = full gate then judge -> agent gets verdict before declaring ready.

## Stage E — Docs / tests / config

- Update `quality.yaml` template, README/USAGE; delete stale `src/plugins/`.
- Tests: stage selection, judge verdict parsing + cache, hook installer idempotency, workflow template render.

## Defaults

- Judge: blocking in CI, advisory locally.
- Judge provider: neutral with env key.
- Fast gate skips tests/coverage/complexity; full gate runs everything enabled.
