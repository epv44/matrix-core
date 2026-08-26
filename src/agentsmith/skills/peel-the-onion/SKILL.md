---
name: peel-the-onion
description: Iterative root-cause technique for layered defects.
---

# Peel the Onion

Use when a fix does not fully clear a finding, or when the same class of issue reappears.

## Process

1. Fix the visible symptom. Re-run the review.
2. If the finding persists or a sibling appears, the fix treated a symptom, not the cause.
3. Peel one layer: find where the value or control actually originates, and fix there.
4. Re-run the review after every peel. Each pass must be cheaper than the last.
5. Stop when a full review returns no new findings.

## Rules

- One layer per cycle; do not rewrite the subsystem in one pass.
- Each layer is independently testable and gate-verified.
- When two consecutive peels produce no new findings, the onion is done.
- Record the layer depth reached so future reviews start from the known-good depth.
