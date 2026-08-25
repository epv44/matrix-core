# Incorporate into projects

## 1. Add to new Python repo

```bash
cd my-py-service
npm init -y
npm install --save-dev --save-exact @epv44/matrixcore@0.5.1
cat > quality.yaml <<'Y'
version: 2
project: my-py-service
review:
  agentsmith: false
Y
python3 -m venv .venv
.venv/bin/pip install ruff==0.16.1 mypy==2.3.0 xenon==0.9.3 deptry==0.25.1
npx quality doctor
npx quality run
```

## 2. Agent host integration

Install the MatrixCore package, then enable the Codex, Claude Code, or Cline bundle described in
`integrations/README.md`. Every host receives the same MCP tools and native completion policy.

## 3. Ensure git status clean after init

```bash
echo ".quality/\ncoverage.json\ndist/\nnode_modules/" >> .gitignore
git add quality.yaml package.json USAGE.md
```

## 4. Commands reference

- `quality doctor` → capability matrix PASS/FAIL (required missing = fail)
- `quality run` → full
- `quality run --fast` → central format/lint/type checks on the current scope
- `quality run --changed --fast` → fast stage on git diff vs main (in-turn LLM loop)
- `quality run --changed` → all enabled checks on git diff vs main
- `quality run --file <path>` → single file, implies changed mode
- `quality run --json` → machine output for tool

## 5. Central policy

The default embedded profile cannot be altered by projects. `matrix-core workspace show` explains
package ownership and environments; `matrix-core policy show` prints effective checks, required
versions, bundled configuration assets, and hashes. Missing or incompatible designated tools fail.

Projects may opt into a complete declarative policy from a public GitHub repository. Updates are explicit:
`quality policy sync` advances the configured ref and writes `matrixcore-policy.lock.json`, while
`quality policy sync --locked` restores that exact commit. Normal validation never uses the network and fails
closed when the locked cache is unavailable. See `POLICY_BUNDLES.md`.

## 6. Link workflow

Engine already lints itself (this repo). Example success run:

```
Node ✓, git ✓, python ✓, ruff ✓, mypy ✓, xenon ✓, deptry ✓, tsc ✓, eslint ✓
Doctor PASSED
Run PASS with workspace and policy hashes
```

## 7. Published package

The current release is `0.5.1`:

```bash
npm install --save-dev --save-exact @epv44/matrixcore@0.5.1
```

## 8. Versioned gate + universal completion enforcement

The expensive operation runs through the `quality_run` **tool** (60s tool budget), not a hook.
Hooks only enforce state.

```
agent turn
  |
quality_run(mode=completion) [tool, configured completion workflow]
  |
  +-- deterministic checks
  +-- GateResult{version, mode=full, fast=false, status, checks} -> .quality/completion-gate.json
  +-- active coordination -> .quality/completion-run.json + completion.lock
  +-- gate.log + host logger
  |
host attempts completion
  |
native Stop/TaskComplete hook [recompute repository/policy identity + read persisted evidence]
  |
  full/non-fast gate exists? version == current? status == PASS?
    |-- no/FAILED/EXPIRED/stale -> { skip, reason }
    +-- all ok -> completion allowed
```

- `matrixcore-hook` translates Cline TaskComplete and Codex/Claude Stop payloads into one shared
  completion decision. It recomputes the workspace version and reads `.quality/completion-gate.json`;
  it never runs the engine.
- Changed/fast feedback is stored independently in `.quality/changed-gate.json` and can never
  authorize completion or overwrite the last full result.
- Terminal gate evidence is **immutable and versioned**. `completion-gate.json` contains the last
  terminal `PASS` or `FAIL`; active state and the cross-process lease are separate. Concurrent MCP
  and CLI callers join one completion run instead of replacing terminal evidence or running twice.
  Completion is blocked when terminal evidence is missing, failed, expired, or stale.
- Every gate outcome is written to `<workspaceRoot>/.quality/gate.log`. Watch live with
  `tail -f .quality/gate.log`. Example lines:

  ```
  2026-08-04T21:33:29.535Z [INFO] quality_run(mode=completion) PASS in 2616ms (version f3f37c8d5ae5)
  2026-08-04T21:33:36.058Z [WARN] completion blocked - workspace changed since gate
  ```

Host hooks block until a current deterministic PASS exists. AgentSmith remains advisory: completed,
partial, timed-out, and provider-error results stay visible in the completion evidence but do not
change deterministic authorization. Findings remain user-selected for any later fix turn.

## 9. Local review traces

Trace capture is local by default and can be disabled with `MATRIXCORE_TRACE=off`. MatrixCore writes
only to `.quality/traces/agentsmith/` and has no upload capability.

```bash
MATRIXCORE_TRACE=agentsmith quality review
quality trace status
quality trace list
```

The MatrixCore source repository has a separate, unpublished eval lab for maintainers. Consumer
installations do not include eval commands, fixtures, or corpus data.

The full consumer profile includes Ruff, Ruff format, mypy, Xenon, and deptry for Python; tsc and
ESLint for TypeScript; and SQLFluff for explicitly declared SQL facets. MatrixCore discovers nested
package roots automatically. A manifest may select one locked GitHub policy bundle but cannot directly add raw
commands, scripts, or executable plugins.
