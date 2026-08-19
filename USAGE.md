# Incorporate into projects

## 1. Add to new Python repo

```bash
cd my-py-service
npm init -y
npm install --save-dev --save-exact @epv44/matrixcore@0.5.0
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

The current public release is `0.5.0`:

```bash
npm install --save-dev --save-exact @epv44/matrixcore@0.5.0
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
  +-- gate.log + host logger
  |
host attempts completion
  |
native Stop/TaskComplete hook [fast: recompute version + read JSON only]
  |
  full/non-fast gate exists? version == current? status == PASS?
    |-- no/FAILED/EXPIRED/RUNNING/stale -> { skip, reason }
    +-- all ok -> completion allowed
```

- `matrixcore-hook` translates Cline TaskComplete and Codex/Claude Stop payloads into one shared
  completion decision. It recomputes the workspace version and reads `.quality/completion-gate.json`;
  it never runs the engine.
- Changed/fast feedback is stored independently in `.quality/changed-gate.json` and can never
  authorize completion or overwrite the last full result.
- The gate is **immutable and versioned**: `GateResult.status` is `RUNNING` (written before the
  engine starts, so a crash can never leave a stale PASS) then `PASS` or `FAIL`. Completion is
  blocked when the gate is missing, `RUNNING`, `FAILED`, `EXPIRED`, or when the workspace version
  no longer matches the gated version.
- Every gate outcome is written to `<workspaceRoot>/.quality/gate.log`. Watch live with
  `tail -f .quality/gate.log`. Example lines:

  ```
  2026-08-04T21:33:29.535Z [INFO] quality_run(mode=full) PASS in 2616ms (version f3f37c8d5ae5)
  2026-08-04T21:33:36.058Z [WARN] completion blocked - workspace changed since gate
  ```

Host hooks block until a current deterministic PASS exists and, when the project opts into
AgentSmith, a current advisory review attempt exists. Findings and provider failures remain
non-blocking and user-selected for any later fix turn.

## 9. Local review traces

Trace capture is off unless the local process explicitly sets `MATRIXCORE_TRACE=agentsmith`. This is
intentionally separate from `quality.yaml`, so a repository cannot silently enable capture for its
contributors. MatrixCore writes only to `.quality/traces/agentsmith/` and has no upload capability.

```bash
MATRIXCORE_TRACE=agentsmith quality review
quality trace status
quality trace list
quality eval curate --trace <trace-id> --case <slug>
quality eval run --mode all --repeat 1
```

Edit the curated `case.yaml` to accept or reject original findings, add missed expected findings,
record narrative follow-up and true code flow, and identify required context. Exact replay measures
model variability; current replay applies the current reviewer assets to the frozen input. The eval
report includes finding precision/recall/F1, verdicts, rejected claims, errors, latency, and required
context coverage. A human-rejected original claim may disappear or remain rejected, but the eval fails
if it is promoted into the validated findings that influence the verdict. Always sanitize a case before
adding it to source control.

The full consumer profile includes Ruff, Ruff format, mypy, Xenon, and deptry for Python; tsc and
ESLint for TypeScript; and SQLFluff for explicitly declared SQL facets. MatrixCore discovers nested
package roots automatically. A manifest may select one locked GitHub policy bundle but cannot directly add raw
commands, scripts, or executable plugins.
