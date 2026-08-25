# AgentSmith unified review engine

The public architecture overview is [ARCHITECTURE.md](../../ARCHITECTURE.md). This document
focuses on AgentSmith implementation and policy details.

AgentSmith freezes one immutable review snapshot and routes it through a shared repository graph, projection planner, structured rule registry, evidence resolver, verifier, deduplicator, coverage model, trace schema, and final result contract. The review result explicitly records whether candidate generation used the `generic` or `specialist` path.

Candidate generation adapts to locked model profiles selected by the project:

- **holistic** — a strong candidate model runs the four version-pinned specialist reviews when the complete eligible projection fits with configured headroom;
- **partitioned** — a smaller model reviews semantic local units and proactive graph interaction units;
- **hybrid** — a strong compact scout prioritizes local and interaction units inspected by the candidate model.

Partitioned and hybrid candidate generation are risk-ranked and bounded by policy: the embedded
defaults select at most four candidate work items, generate at most two candidates per work item,
and verify at most four candidates, with optional
explicit candidate and verification token budgets. The candidate default covers the selected work-item
projection; the verification aggregate reserves one verifier input budget for each of the four possible
candidates. Each work item includes at most four concise rules. Parallelism defaults to one in-flight
model call and the total review deadline defaults to 1800000ms. Lower-ranked and token-budget-omitted changes remain in the frozen scope and are reported
as explicit coverage omissions. When the deadline fires, no new scout, candidate, or verifier calls
start, in-flight provider calls are aborted, completed candidates, evidence, and verified findings
are preserved, and unfinished work is reported as timeout omissions; the result is explicitly
partial and never presented as approval.

Context size is a packing constraint, not a product boundary. Automatic routing uses 70% of the selected profile's context at most and reserves explicit reasoning/output space. Unknown models cannot be inferred as strong from their names; they must be declared in an embedded or locked GitHub policy profile.

## Pipeline

1. Capture staged, unstaged, untracked, renamed, and deleted working-tree changes, retaining deleted preimages and all omissions. An explicit review base additionally opts into the `<base>...HEAD` committed delta; no remote-tracking branch is added implicitly.
2. Build the Python/TypeScript repository graph and derive changed symbols from hunk overlap.
3. Construct complete and compact projections with deterministic token estimates and selection audits.
4. Route a full-fit strong candidate to four specialist prompts; route every other case to generic partitioned or hybrid candidate generation.
5. Normalize candidates into one versioned internal contract.
6. Resolve each required evidence request with exact symbol, relationship, path, or literal matching and record a request-level outcome.
7. Verify every evidence-complete candidate with the configured low-output verifier profile, requiring exact citations and allowing one bounded citation repair.
8. Publish only verified findings, then deduplicate, rank, retain specialist attribution, and report actual file/symbol/edge/evidence coverage.

An empty partial/error result is `incomplete`, never approval. Findings must anchor to changed hunks; unchanged files can support evidence but cannot become finding locations.

## Human report contract

Every report uses `AgentSmith Summary`, `Verified Findings`, `Candidate Verification`, and `Coverage`.
`Coverage Limitations` and `Review Errors` appear only when applicable. Specialist runs additionally
render `Specialist Reviews` with Architecture, Performance, Correctness, and Semantic reviewer sections;
each reviewer has `Summary` and `Candidate Outcomes` subsections. Generic runs never render specialist
headings or imply that specialist prompts ran.

## Project model roles

```yaml
review:
  agentsmith: true
  mode: auto
  models:
    candidate: qwen35-9b-local
    scout: qwen35-122b-scout-local
    verifier: qwen35-9b-verifier-local
```

Projects may select only profiles approved by the active policy. A forced mode that cannot run with those profiles fails explicitly.

Candidate generation uses a compact bounded JSON wire schema and expands it into the stable internal finding contract. The default candidate profile allows 4096 output tokens with a 300-second request timeout; the verifier uses 512 tokens with the same 300-second timeout. The opt-in 122B scout uses 1024 tokens with 180 seconds. Ollama model residency is kept alive for the review budget plus five minutes (35 minutes under the default policy).

The four specialist prompt bodies retain the 0.4 architecture, performance, correctness, and semantic language. Their only transport change is JSON in place of YAML. The top-level AgentSmith summary is deterministic; there is no fifth summarizer call.

`ReviewProvider` implements `health(signal)` and `invoke({ profile, prompt, outputKind, allowedFiles, maxCandidates, signal })`, returning raw output, token usage, and optional completion metadata. Providers never download models implicitly.

## Local traces and evals

Tracing is local by default and has no uploader. It retains the newest 20 schema-v5 traces within a
250 MiB budget under `.quality/traces/agentsmith/`. Set `MATRIXCORE_TRACE=off` to disable it, or
`MATRIXCORE_TRACE=agentsmith` to mark an explicitly captured run. Traces include projections, work
items, prompts, raw responses (including structured-output failures), completion metadata, evidence,
verification outcomes, request-level evidence coverage, citation repairs, and final provenance.
Schema v5 also captures tracked and nonignored untracked repository inputs in a deduplicated SHA-256 object store,
with a manifest for file bytes, executable bits, safe relative symlinks, and deleted paths. The source
objects participate in the same retention budget. Because source snapshots can contain proprietary code
or credentials that are not ignored by Git, keep `.quality/` private and review sanitization before
curating or sharing a case.

The MatrixCore source repository contains an unpublished diagnostic lab under
`tools/agentsmith-evals/`. It evaluates snapshot, graph, planning, candidate, evidence, verification,
aggregation, and reporting stages through deterministic, recorded, and live tiers. The lab and its
curated corpus are not exported by AgentSmith or included in npm artifacts.

`quality_fix` accepts only published verified finding IDs and returns a version-bound task for the active host model. The review model never edits code.
