---
name: matrix-core
description: Run MatrixCore deterministic gates and advisory AgentSmith reviews, prepare selected fixes, and verify the final workspace.
---

# MatrixCore workflow

Use the MatrixCore MCP tools in repositories containing a v2 `quality.yaml`. Planning-only turns do
not require a gate and must bypass completion enforcement before workspace resolution. After edits,
run changed/fast checks, then call `quality_run` with `mode: completion`. Completion runs either the
embedded profile or the project's verified, locked declarative GitHub policy bundle and includes
advisory AgentSmith only when the project opts in. Report findings without fixing them; after the user selects finding
IDs, `quality_fix` prepares a version-bound task for the active Claude Code model. Ollama reviews
code but never writes it.
