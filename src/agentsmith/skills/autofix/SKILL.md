---
name: autofix
description: Turn severity-ranked review findings into concrete, verified patches.
---

# Autofix

When review findings exist, turn them into minimal patches.

## Process

1. Read findings in severity order: blockers first, then warnings.
2. For each finding, locate the code, reproduce the issue mentally, and confirm the root cause.
3. Make the smallest change that fixes the root cause, not just the reported instance.
4. Add or update a test that fails without the fix and passes with it.
5. Re-run the quality gate for the affected language and confirm the finding disappears.

## Rules

- Do not silently change behavior beyond the finding.
- If a blocker requires a design decision, escalate to the orchestrator instead of guessing.
- Keep each patch independent; one finding per commit/change where possible.
- Never fix by suppressing the check or weakening the rule.
- Report what you fixed and what you deliberately left for review.
