# Use MatrixCore with Cline

MatrixCore uses Cline's native MCP and hook systems. The native `TaskComplete` hook is the enforcement boundary. Cline plugins are not used for completion enforcement: the current public `AgentPlugin.afterRun` callback is observational and cannot return a decision that resumes a blocked run.

## Install the package

Install the published package as a project dependency:

```bash
npm install --save-dev --save-exact @epv44/matrixcore@0.5.1
```

The supplied settings use `npx --no-install`, so they resolve only an already-installed local
binary and never download packages. Contributors working from a checkout may build and link that
checkout separately.

## Add MCP tools

Merge `integrations/cline/cline_mcp_settings.fragment.json` into Cline's `cline_mcp_settings.json`. Restart or reload MCP and confirm the `matrixcore` server exposes:

- `quality_run`
- `quality_status`
- `quality_fix`

## Enable completion enforcement

Copy `integrations/cline/hooks/TaskComplete` to the global Cline hooks directory or the project's `.clinerules/hooks/` directory on macOS/Linux and make it executable. On Windows copy `TaskComplete.ps1`. Enable hooks in Cline. This is supported by Cline 3.x editor and CLI hook discovery; plugins remain limited to SDK, CLI, and Kanban and are not required by MatrixCore.

The hook reads Cline's JSON payload, checks the current deterministic artifact, and returns `cancel: true` when the gate is missing, failed, or stale. It does not run checks itself. Repositories without `quality.yaml` are unaffected.

## Workflow

1. Call `quality_run(mode=changed, fast=true)` after edits.
2. Call `quality_run(mode=review)` for combined deterministic and advisory review.
3. Call `quality_fix` with selected finding IDs and let the active Cline model edit code.
4. Call `quality_run(mode=completion)` before completion.

Ollama is review-only. Its availability and findings never override deterministic completion policy.
