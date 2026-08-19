---
name: matrix-core
description: Run MatrixCore deterministic gates and advisory AgentSmith reviews, prepare selected fixes, and verify the final workspace.
---

# MatrixCore workflow

Use the MatrixCore MCP tools for repositories containing `quality.yaml`.

Planning-only turns do not require a gate. When the host reports Plan mode, the completion hook must
allow the turn before resolving the workspace or requesting `quality_run`.

1. After edits, call `quality_run` with `mode: changed` and `fast: true`.
2. After all edits, call `quality_run` with `mode: completion`. It runs the resolved embedded or locked GitHub deterministic profile in full mode and also runs its AgentSmith profile when the project's v2 manifest opts in.
3. Reproduce the complete `reviewMarkdown` report verbatim, including every validated finding, rejected
   claim, reviewer summary, and provider error. Never summarize a result containing findings as approved
   or passed. Rejected claims are audit-only and cannot be sent to `quality_fix`; validated findings remain
   advisory and must not be fixed automatically.
4. Only after the user selects finding IDs, call `quality_fix`; apply the returned task with the active host model and normal edit tools. Never use Ollama to write code.

MatrixCore owns execution semantics and evidence. Projects may use the embedded policy or select one
verified, locked declarative GitHub policy bundle containing known checks and AgentSmith assets. They may
also declare application-resolution metadata and enable AgentSmith in `quality.yaml`. If
Ollama is unavailable, clearly report that the advisory review could not run. Ask the human to select
finding IDs before preparing any fix.
