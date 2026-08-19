---
name: review-code
description: The AgentSmith v2 review workflow: plan bounded context, generate candidates, resolve evidence, and verify findings.
---

# Review Code

Run this workflow for every code review through AgentSmith.

## Workflow

1. Freeze and normalize the diff, manifest, omissions, and repository/change graph.
2. Select holistic, partitioned, or hybrid candidate generation from the locked model profiles and projection budget.
3. In partitioned mode, review both semantic local units and high-value interaction units.
4. Normalize every candidate into the shared v2 contract, resolve structural evidence, and verify each publishable candidate.
5. Deduplicate and rank verified findings, then report coverage, omissions, evidence gaps, and provenance.
6. Hand selected finding IDs to the host-driven `quality_fix` workflow; use peel-the-onion when fixes do not clear findings.

## Rules

- Never re-review linter output; the deterministic gate owns that.
- Findings must anchor to changed code; unchanged files may support evidence but cannot become finding locations.
- Only verified findings are published. Likely, rejected, and insufficient-evidence candidates remain audit data.
- If a provider or work unit cannot complete, report an incomplete review rather than inventing findings.
