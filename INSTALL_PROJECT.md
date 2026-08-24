# MatrixCore — Set up the quality gate in your project

Project-agnostic engine setup. Works with the plain CLI, CI, or any supported MCP host. Native host
integration lives under `integrations/`; Cline setup is documented in `INSTALL_CLINE.md`.

## 1. Pre-reqs

- Node.js, npm, and git.
- The toolchain the checks need. Verify with the engine's doctor:

  ```bash
  npm install --save-dev --save-exact @epv44/matrixcore@0.5.1
  npx --no-install matrix-core doctor
  ```

  Required workspace binaries must match the embedded exact policy: Ruff 0.16.1, mypy 2.3.0,
  Xenon 0.9.3, and deptry 0.25.1 for Python; SQLFluff 4.2.2 for declared SQL facets; TypeScript
  5.9.3 and ESLint 9.39.5 for TypeScript.

## 2. Git repo (required for a stable gate version)

The gate certifies a workspace version = git HEAD + sorted (path, state, content-hash) of every
changed/untracked file. `git init` if not a repo — otherwise the engine hashes the entire tree (including
`.venv`, caches), which is slow and changes on every run, so the gate would block every completion as stale.

```bash
git init
```

## 3. Ignore churn

Any file a check writes or that changes while you work must be ignored, or it flips the workspace version
mid-work and invalidates the last PASS. Add to `.gitignore`:

```gitignore
.quality/
coverage.json
coverage.xml
.coverage
node_modules/
dist/
.venv/
venv/
__pycache__/
.mypy_cache/
.ruff_cache/
.pytest_cache/
*.db
*.db-shm
*.db-wal
.env
```

Add project-specific artifacts too (generated exports, keychain dumps, etc.). Verify nothing churns:

```bash
git status --porcelain   # only stable source files
```

## 4. quality.yaml

```yaml
version: 2
project: my-application
review:
  agentsmith: true
```

The embedded policy approves role-specific 9B and 122B profiles. Bind review roles by
profile ID when selecting models:

```yaml
review:
  agentsmith: true
  mode: auto
  models:
    candidate: qwen35-9b-local
    scout: qwen35-122b-scout-local
    verifier: qwen35-9b-verifier-local
```

Install only the models you intend to use; MatrixCore never downloads them implicitly:

```bash
ollama pull qwen3.5:9b-q4_K_M
ollama pull qwen3.5:122b-a10b
```

For SQLite SQL embedded in Python, add only application-resolution metadata:

```yaml
application:
  sql:
    - root: finance
      dialect: sqlite
      templater: raw
      sources: [files, python]
```

## 5. Run

```bash
# from the configured project
npx --no-install matrix-core run --changed --fast
npx --no-install matrix-core completion
```

### Nested projects

MatrixCore discovers nested package roots from application manifests and lockfiles. Use
`matrix-core workspace show` to inspect ownership and `matrix-core policy show` to inspect the
centrally owned checks, versions, assets, and hashes.

## 6. Reading the output

- Per-check status is PASS / FAIL / ERROR. Missing or incompatible required tools fail closed.
- The terminal gate is **immutable and versioned**: `completion-gate.json` is replaced only by a
  terminal `PASS`/`FAIL`. Active-run and lock artifacts are separate, so a duplicate start cannot
  erase a current PASS.

## 7. Caveats

- `quality run` and MCP `quality_run` use the same gate service and persist identical evidence.
- Concurrent CLI/MCP completion requests are serialized per repository and reuse one result.
- `--changed` needs a git repo; consumer gates never invoke application tests.
- `completion` runs the central deterministic profile and runs the central AgentSmith profile only
  when `review.agentsmith: true` is declared in the v2 manifest.
- AgentSmith results are advisory and remain reported even when partial or unavailable; exact-state
  deterministic PASS controls completion authorization.
- Completion enforcement uses each host's native hook and the shared `matrixcore-hook` executable.
- Planning-only turns bypass completion enforcement before workspace resolution.

## 8. Agent enforcement

Install the appropriate native integration from `integrations/`. For Cline, see `INSTALL_CLINE.md`.
