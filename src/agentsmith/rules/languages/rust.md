---
name: rust
description: Rust review rules for safety, ownership, correctness, and performance.
---
# Rust anti-pattern checklist
Check avoidable `unwrap` or `expect` in recoverable paths, panic across API boundaries, unsafe blocks without documented invariants, incorrect `Send`/`Sync` assumptions, locks held across `.await`, blocking work in async tasks, reference cycles with `Rc`/`Arc`, excessive cloning, accidental allocation in hot loops, unchecked integer conversion, lossy casts, ignored `Result`, error context loss, iterator invalidation assumptions, nondeterministic lock ordering, unbounded channels, cancellation-unsafe operations, resource lifetime leaks, public API semver breaks, incorrect feature gating, and tests that miss failure paths. Treat compiler and Clippy diagnostics in the deterministic report as primary evidence. Report only defects visible in the frozen scope.
