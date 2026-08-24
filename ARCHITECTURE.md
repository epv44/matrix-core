# MatrixCore architecture

MatrixCore is one review engine with adaptive candidate generation. Capture, repository
graph construction, projection planning, evidence resolution, verification, deduplication,
ranking, coverage, tracing, and output contracts are shared across model sizes.

```text
Capture + normalize
        |
Repository / change graph
        |
Projection planner (token budget + evidence)
        |
Capability + mode router
   +-------------------+------------------+
   |                                      |
strong candidate + full fit          all other routes
   |                                      |
four specialist reviews        generic local/interaction work
   |                                      |
   +-------------------+------------------+
           |
Candidate normalization
           |
Evidence resolution -> verification -> deduplication/ranking
           |
Unified ReviewResult + coverage + optional local trace
```

## Routing

The router treats context as a packing constraint. It reserves output and safety space and
uses at most 70% of the selected model context for input. A strong candidate model receives four
independent architecture, performance, correctness, and semantic reviews when the complete projection
fits. Otherwise MatrixCore uses the generic engine: a compact strong-model scout when configured,
followed by bounded local and interaction work, or bounded partitioned work directly. Specialist
prompts are never used by the small-model path.

Partitioned review always creates two kinds of work:

- local units inspect changed functions, classes, modules, or hunk fallbacks;
- interaction units compare high-value graph relationships such as callers/callees,
  interfaces/implementations, schemas/consumers, producers/consumers, configuration readers,
  and authorization boundaries.

This preserves local recall while proactively recovering one-hop cross-file defects. High-risk
changes may expand to a bounded second hop. Every unit uses the same candidate contract and feeds
the same evidence and verification pipeline.

The embedded policy bounds partitioned review to the four highest-priority candidate work items and
verifies at most four generated candidates (configurable higher, such as 8 + 8, for faster
providers). Parallelism defaults to one in-flight model call and the total review deadline defaults
to thirty minutes; every limit is configurable. The complete worktree remains in the frozen manifest,
while lower-ranked and token-budget-omitted work is reported as bounded coverage rather than silently
treated as reviewed. AgentSmith does not control deterministic completion authorization. Timeouts
abort in-flight provider calls, preserve completed candidates, evidence, and verified findings, and
mark unfinished work as explicit timeout omissions; a timed-out review is always partial and must
never be interpreted as semantic approval.

## Approved local model profiles

The embedded policy currently provides:

| Profile | Model | Capability | Context |
| --- | --- | --- | ---: |
| `qwen35-9b-local` | `qwen3.5:9b-q4_K_M` | small | 8,192 |
| `qwen35-9b-verifier-local` | `qwen3.5:9b-q4_K_M` | small | 8,192 |
| `qwen35-122b-local` | `qwen3.5:122b-a10b` | strong | 131,072 |
| `qwen35-122b-scout-local` | `qwen3.5:122b-a10b` | strong | 131,072 |

Projects bind review roles to these policy-approved IDs:

```yaml
review:
  agentsmith: true
  mode: auto
  models:
    candidate: qwen35-9b-local
    scout: qwen35-122b-scout-local
    verifier: qwen35-9b-verifier-local
```

The binding above enables hybrid routing for changes that do not fit the small candidate model.
Use `qwen35-122b-local` as the candidate for holistic-first review when the full projection fits.
That route runs the four version-pinned specialist prompts; an oversized projection falls back to the
generic bounded engine rather than publishing partial specialist narratives.
Model names are not inferred as strong, and projects cannot select arbitrary IDs from the embedded
policy. Install models explicitly with Ollama; MatrixCore never downloads them implicitly:

```bash
ollama pull qwen3.5:9b-q4_K_M
ollama pull qwen3.5:122b-a10b
```

## Evidence, verification, and coverage

Candidates must anchor to changed code. Unchanged files are resolved as supporting evidence only.
The verifier can reject unsupported, hypothetical, or out-of-scope claims. Only verified findings
are published. Results report changed-file/symbol coverage, local and interaction work, eligible
graph edges, evidence gaps, omissions, tokens, and global-scan scope.

## Traces and evaluation

Tracing is disabled by default and is local-only. `MATRIXCORE_TRACE=agentsmith` writes schema-v2
traces under `.quality/traces/agentsmith/`; there is no uploader or analytics endpoint. Curated
cases replay the same frozen snapshot through holistic, partitioned-local, partitioned-evidence,
partitioned-interactions, and hybrid variants and classify expected defects as L0 through L3.

See [README.md](README.md) for installation, [INSTALL_PROJECT.md](INSTALL_PROJECT.md) for project
setup, and [src/agentsmith/README.md](src/agentsmith/README.md) for implementation details.
