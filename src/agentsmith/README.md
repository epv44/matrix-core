# AgentSmith unified review engine

The public architecture overview is [ARCHITECTURE.md](../../ARCHITECTURE.md). This document
focuses on AgentSmith implementation and policy details.

AgentSmith freezes one immutable review snapshot and routes it through a shared repository graph, projection planner, structured rule registry, evidence resolver, verifier, deduplicator, coverage model, trace schema, and final result contract.

Candidate generation adapts to locked model profiles selected by the project:

- **holistic** — a strong model reviews the complete eligible projection when it fits with configured headroom;
- **partitioned** — a smaller model reviews semantic local units and proactive graph interaction units;
- **hybrid** — a strong compact scout prioritizes local and interaction units inspected by the candidate model.

Partitioned and hybrid candidate generation are risk-ranked and bounded by policy: the embedded
defaults select at most four candidate work items and verify at most four candidates, with optional
explicit candidate and verification token budgets (defaults are twice the corresponding model input
budget). Parallelism defaults to one in-flight model call and the total review deadline defaults to
180000ms. Lower-ranked and token-budget-omitted changes remain in the frozen scope and are reported
as explicit coverage omissions. When the deadline fires, no new scout, candidate, or verifier calls
start, in-flight provider calls are aborted, completed candidates, evidence, and verified findings
are preserved, and unfinished work is reported as timeout omissions; the result is explicitly
partial and never presented as approval.

Context size is a packing constraint, not a product boundary. Automatic routing uses 70% of the selected profile's context at most and reserves explicit reasoning/output space. Unknown models cannot be inferred as strong from their names; they must be declared in an embedded or locked GitHub policy profile.

## Pipeline

1. Capture committed, staged, unstaged, untracked, renamed, and deleted changes, retaining deleted preimages and all omissions.
2. Build the Python/TypeScript repository graph and derive changed symbols from hunk overlap.
3. Construct complete and compact projections with deterministic token estimates and selection audits.
4. Route to holistic, partitioned, or hybrid candidate generation.
5. Normalize candidates into one v2 contract.
6. Resolve bounded structural evidence from the frozen graph and repository.
7. Verify every publishable candidate with the configured verifier profile; the verifier defaults to the candidate profile.
8. Publish only verified findings, then deduplicate, rank, and report actual file/symbol/edge/evidence coverage.

An empty partial/error result is `incomplete`, never approval. Findings must anchor to changed hunks; unchanged files can support evidence but cannot become finding locations.

## Project model roles

```yaml
review:
  agentsmith: true
  mode: auto
  models:
    candidate: qwen35-9b-local
    scout: qwen35-122b-local
    verifier: qwen35-9b-local
```

Projects may select only profiles approved by the active policy. A forced mode that cannot run with those profiles fails explicitly.

`ReviewProvider` implements `health(signal)` and `invoke({ profile, prompt, outputKind, allowedFiles, signal })`, returning raw output and token usage. Providers never download models implicitly.

## Local traces and evals

Tracing is disabled by default and has no uploader. `MATRIXCORE_TRACE=agentsmith` writes schema-v2 traces under `.quality/traces/agentsmith/`, including projections, work items, prompts, raw responses, evidence, verification outcomes, coverage, and final provenance.

Curated eval cases replay the same snapshot through holistic, partitioned-local, partitioned-evidence, partitioned-interactions, and hybrid modes. Cases label expected findings L0-L3 and reports include class-specific precision/recall, coverage, latency, and tokens.

`quality_fix` accepts only published verified finding IDs and returns a version-bound task for the active host model. The review model never edits code.
