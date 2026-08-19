# GitHub policy bundles

MatrixCore can consume a declarative policy bundle from a public GitHub repository without a policy server.
GitHub is used only by an explicit synchronization command. Gates, reviews, status checks, MCP tools, and hooks
read a verified local cache and never access the network.

## Project configuration

```yaml
version: 2
project: example
policy:
  source: github
  repository: acme/quality-policy
  ref: stable
  manifest: matrixcore/policy.json
review:
  agentsmith: true
  mode: auto
  models:
    candidate: qwen35-9b-local
    scout: qwen35-122b-local
    verifier: qwen35-9b-local
```

The repository and ref are project-owned. `ref` may be a branch, tag, or commit. MatrixCore resolves it to an
immutable commit only during synchronization.

```bash
# Deliberately advance the configured ref and update the committed lock.
quality policy sync

# Restore exactly what the committed lock names; used by CI and new workstations.
quality policy sync --locked

# These commands never use the network.
quality policy status
quality policy show
quality run --full
```

Commit `matrixcore-policy.lock.json`. Keep `.quality/` ignored; verified bundles are cached under
`.quality/policies/<policyHash>/`. A remote-policy project with no valid lock/cache fails closed and tells the user
which sync command to run. It never falls back to a different embedded policy.

## Contract

The machine contract is `dist/policy/github-policy-bundle.schema.json`. A v1 `policy.json` declares:

- a policy ID and minimum MatrixCore version;
- installed MatrixCore check IDs, exact tool versions, and check-specific typed settings;
- locked AgentSmith model profiles, default role bindings, routing, graph, partitioning, evidence, and verification policy;
- data and Markdown assets with byte sizes, media types, and SHA-256 digests.

Policy bundles cannot define raw commands, plugins, JavaScript, shell files, or executable scripts. Unknown checks
fail with an instruction to update MatrixCore. Executable adapters and helpers remain part of the audited npm
package. The v1 TypeScript ESLint policy uses the `embedded-recommended` executable profile while the remote
manifest controls its exact tool version and zero-warning setting.

Supported typed settings are:

| Check | Settings |
| --- | --- |
| `python.ruff`, `python.ruff-format`, `python.mypy`, `typescript.tsc`, `sql.sqlfluff` | `configAsset` |
| `python.xenon` | `configAsset`, `maxAbsolute`, `maxModules`, `maxAverage`, `ignore`, `exclude` |
| `python.deptry` | `ignore` containing `DEPnnn` codes |
| `typescript.eslint` | `profile: embedded-recommended`, `maxWarnings: 0` |

AgentSmith uses the fixed `agentsmith/` layout for review assets, including the structured
`rules/registry.yaml`. Every referenced file must appear in the manifest asset inventory. Projects may bind
candidate, scout, and verifier roles only to model profile IDs declared by the locked policy.

## Identity and trust

The lock records the configured source, resolved 40-character commit, raw manifest digest, content-derived policy
hash, every asset digest, and a reviewable check/profile summary. The policy hash is SHA-256 over canonical JSON
plus the lexically sorted `path:sha256` asset inventory. Gate and review evidence includes that hash.

V1 trusts GitHub TLS and the public repository selected by the project. It does not support tokens, private
repositories, signatures, downloaded code, automatic updates, or background network traffic. Review sync diffs
and the lock-file change before committing them.
