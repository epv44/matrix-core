import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveWorkspaceSet } from "../workspace.js";
import { resolveConfig } from "../config-resolver.js";
import { GraphStore } from "./store.js";
import { discoverGraphFiles, TreeSitterProvider, TypeScriptCompilerProvider } from "./providers.js";
import type {
  GraphContext,
  GraphContextEdge,
  GraphContextNode,
  GraphProvider,
  GraphSnapshot,
  GraphSymbol,
} from "./types.js";
import type { ReviewScope } from "../../agentsmith/scope.js";
import { parseChangedRanges } from "../diff.js";
import type { ReviewGraphPolicy } from "../types.js";

function estimate(value: string) {
  return Math.ceil(value.length / 2.5);
}
function commit(root: string) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
function symbolKey(symbol: GraphSymbol) {
  return `${symbol.file}:${symbol.qualifiedName}`;
}
function providerRank(provider: string) {
  return provider === "typescript-compiler" ? 0 : provider === "tree-sitter-wasm" ? 1 : 2;
}
function confidenceRank(confidence: GraphContextEdge["confidence"]) {
  return confidence === "exact" ? 0 : confidence === "syntactic" ? 1 : 2;
}
function canonicalSymbols(symbols: GraphSymbol[]): GraphSymbol[] {
  const grouped = new Map<string, GraphSymbol[]>();
  for (const symbol of symbols) {
    const values = grouped.get(symbolKey(symbol)) ?? [];
    values.push(symbol);
    grouped.set(symbolKey(symbol), values);
  }
  return [...grouped.values()]
    .map(
      (values) =>
        [...values].sort(
          (left, right) =>
            providerRank(left.provider) - providerRank(right.provider) ||
            left.provider.localeCompare(right.provider) ||
            left.startLine - right.startLine ||
            left.endLine - right.endLine ||
            left.kind.localeCompare(right.kind),
        )[0],
    )
    .sort((left, right) => symbolKey(left).localeCompare(symbolKey(right)));
}
function edgeKey(edge: GraphContextEdge) {
  return `${edge.kind}:${edge.source}:${edge.target ?? edge.targetText}`;
}
function canonicalEdges(edges: GraphContextEdge[]): GraphContextEdge[] {
  const grouped = new Map<string, GraphContextEdge[]>();
  for (const edge of edges) {
    const values = grouped.get(edgeKey(edge)) ?? [];
    values.push(edge);
    grouped.set(edgeKey(edge), values);
  }
  return [...grouped.values()]
    .map(
      (values) =>
        [...values].sort(
          (left, right) =>
            confidenceRank(left.confidence) - confidenceRank(right.confidence) ||
            providerRank(left.provider) - providerRank(right.provider) ||
            left.provider.localeCompare(right.provider) ||
            left.targetText.localeCompare(right.targetText),
        )[0],
    )
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
}
function changedRanges(diff: string) {
  const ranges = new Map<string, Array<{ start: number; end: number }>>();
  for (const range of parseChangedRanges(diff)) {
    const current = ranges.get(range.file) ?? [];
    current.push({ start: range.start, end: range.end });
    ranges.set(range.file, current);
  }
  return ranges;
}
function edgeBaseScore(kind: GraphContextEdge["kind"]) {
  if (kind === "implements" || kind === "extends") return 100;
  if (["schema-user", "serialization", "producer-consumer", "config"].includes(kind)) return 90;
  if (kind === "calls") return 80;
  if (kind === "reads-type" || kind === "references") return 70;
  if (kind === "test-reference") return 40;
  return kind === "imports" ? 10 : 20;
}
function resolveTarget(edge: GraphContextEdge, symbols: GraphSymbol[]): GraphSymbol | undefined {
  if (edge.target) return symbols.find((symbol) => symbolKey(symbol) === edge.target);
  const text = edge.targetText.replace(/["']/g, "");
  const name = text
    .split(/[./:#]/)
    .filter(Boolean)
    .at(-1);
  if (!name) return undefined;
  const sourceFile = edge.source.split(":")[0];
  const sourceDir = path.posix.dirname(sourceFile);
  const modulePath = path.posix.normalize(path.posix.join(sourceDir, text)).replace(/\.(js|ts|tsx|jsx|py)$/, "");
  return symbols.find(
    (symbol) =>
      symbol.name === name ||
      symbol.qualifiedName === text ||
      symbol.file.replace(/\.(js|ts|tsx|jsx|py)$/, "") === modulePath,
  );
}

export class RepositoryGraph {
  private readonly providers: GraphProvider[] = [new TypeScriptCompilerProvider(), new TreeSitterProvider()];
  constructor(readonly root: string) {}
  private store() {
    return new GraphStore(this.root);
  }

  async ensureReady(): Promise<GraphSnapshot> {
    const config = resolveConfig({ cwd: this.root });
    const workspaceHash = resolveWorkspaceSet(config.configRoot, config.config.application).workspaceHash;
    const store = this.store();
    const files = discoverGraphFiles(config.configRoot);
    const previous = store.snapshot();
    const indexedHash = previous.snapshotHash ? previous.snapshotHash : "";
    const providerVersions = Object.fromEntries(this.providers.map((provider) => [provider.id, provider.version]));
    if (
      previous.state === "READY" &&
      previous.workspaceHash === workspaceHash &&
      indexedHash &&
      JSON.stringify(previous.providerVersions) === JSON.stringify(providerVersions) &&
      store.matchesFiles(files)
    ) {
      store.close();
      return previous;
    }
    store.setState(
      previous.state === "ABSENT" ? "BUILDING" : "UPDATING",
      workspaceHash,
      commit(config.configRoot),
      providerVersions,
    );
    const priorFiles = store.files();
    const priorByPath = new Map(priorFiles.map((file) => [file.path, file.contentHash]));
    const currentByPath = new Map(files.map((file) => [file.path, file.contentHash]));
    const changed = files.filter((file) => priorByPath.get(file.path) !== file.contentHash);
    const removed = priorFiles.filter((file) => !currentByPath.has(file.path)).map((file) => file.path);
    const providerChanged = JSON.stringify(previous.providerVersions) !== JSON.stringify(providerVersions);
    const indexedFiles = previous.state === "ABSENT" || providerChanged ? files : changed;
    const facts = (
      await Promise.all(this.providers.map((provider) => provider.indexFiles(config.configRoot, indexedFiles)))
    ).filter((fact) => fact.files.length > 0);
    const snapshot =
      previous.state === "ABSENT" || providerChanged
        ? store.replaceFacts(facts, workspaceHash, commit(config.configRoot))
        : store.updateFacts(
            facts,
            [...changed.map((file) => file.path), ...removed],
            workspaceHash,
            commit(config.configRoot),
          );
    store.close();
    return snapshot;
  }

  async getContext(scope: ReviewScope, budgetTokens: number, policy?: ReviewGraphPolicy): Promise<GraphContext> {
    await this.ensureReady();
    const store = this.store();
    const snapshot = store.snapshot();
    const symbols = canonicalSymbols(store.symbols());
    const rawEdges = store.edges();
    const ranges = changedRanges(scope.diff);
    const changed = symbols.filter((symbol) => {
      if (!scope.changedFiles.includes(symbol.file)) return false;
      const fileRanges = ranges.get(symbol.file);
      return (
        !fileRanges?.length ||
        fileRanges.some((range) => symbol.startLine <= range.end && symbol.endLine >= range.start)
      );
    });
    const changedKeys = new Set(changed.map(symbolKey));
    const nodes = new Map<string, GraphContextNode>();
    const selectedEdges: GraphContextEdge[] = [];
    const upsertNode = (symbol: GraphSymbol, score: number, distance: number) => {
      const key = symbolKey(symbol);
      const current = nodes.get(key);
      nodes.set(key, {
        symbol,
        score: Math.max(current?.score ?? 0, score),
        distance: Math.min(current?.distance ?? distance, distance),
      });
    };
    for (const symbol of changed) upsertNode(symbol, 130, 0);
    const resolvedEdges = canonicalEdges(
      rawEdges.map((edge) => {
        const target = resolveTarget(edge, symbols);
        return target && !edge.target ? { ...edge, target: symbolKey(target), targetSymbol: target } : edge;
      }),
    );
    const symbolsByKey = new Map(symbols.map((symbol) => [symbolKey(symbol), symbol]));
    for (const edge of resolvedEdges) {
      const sourceChanged = changedKeys.has(edge.source);
      const targetChanged = edge.target ? changedKeys.has(edge.target) : false;
      if (!sourceChanged && !targetChanged) continue;
      const distance = sourceChanged && targetChanged ? 0 : 1;
      const score =
        edgeBaseScore(edge.kind) + (sourceChanged && targetChanged ? 30 : 0) + (edge.confidence === "exact" ? 10 : 0);
      const source = symbolsByKey.get(edge.source);
      const target = edge.target ? symbolsByKey.get(edge.target) : undefined;
      if (source) upsertNode(source, score, distance);
      if (target) upsertNode(target, score, distance);
      selectedEdges.push({ ...edge, sourceSymbol: source, targetSymbol: target });
    }
    const highRiskChange =
      /\b(interface|schema|serialize|deserial|auth|permission|config|transaction|async|await|lock|mutex|state|owner)\b/i.test(
        scope.diff,
      );
    if (policy?.enableHighRiskTwoHopExpansion && policy.maxHops === 2 && highRiskChange) {
      const firstHop = new Set([...nodes.keys()]);
      const selectedEdgeKeys = new Set(selectedEdges.map(edgeKey));
      for (const edge of resolvedEdges) {
        if (!firstHop.has(edge.source) && !(edge.target && firstHop.has(edge.target))) continue;
        const source = symbolsByKey.get(edge.source);
        const target = edge.target ? symbolsByKey.get(edge.target) : undefined;
        let added = false;
        for (const symbol of [source, target]) {
          if (symbol && !nodes.has(symbolKey(symbol))) {
            upsertNode(symbol, Math.max(1, edgeBaseScore(edge.kind) - 30), 2);
            added = true;
          }
        }
        const key = edgeKey(edge);
        if (added && !selectedEdgeKeys.has(key)) {
          selectedEdges.push({ ...edge, sourceSymbol: source, targetSymbol: target });
          selectedEdgeKeys.add(key);
        }
      }
    }
    const ranked = [...nodes.values()].sort(
      (a, b) =>
        b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.startLine - b.symbol.startLine,
    );
    for (const node of ranked) {
      try {
        const content = fs.readFileSync(path.join(this.root, node.symbol.file), "utf8").split("\n");
        node.excerpt = content
          .slice(Math.max(0, node.symbol.startLine - 2), Math.min(content.length, node.symbol.endLine + 1))
          .join("\n")
          .slice(0, 2000);
      } catch {
        node.excerpt = undefined;
      }
    }
    const renderedParts: string[] = [
      "## Repository graph context",
      `Graph snapshot: ${snapshot.snapshotHash ?? "none"}`,
    ];
    const selectedNodeKeys: string[] = [];
    for (const node of ranked) {
      const part = `- ${node.symbol.kind} ${node.symbol.qualifiedName} (${node.symbol.file}:${node.symbol.startLine}, ${node.symbol.provider}, ${node.distance === 0 ? "changed" : "related"})`;
      if (estimate(renderedParts.join("\n") + "\n" + part) > budgetTokens) break;
      renderedParts.push(part);
      selectedNodeKeys.push(symbolKey(node.symbol));
    }
    const rendered = renderedParts.join("\n");
    store.close();
    return {
      snapshot,
      changedSymbols: changed,
      nodes: ranked,
      edges: selectedEdges,
      rendered,
      tokenEstimate: estimate(rendered),
      budgetTokens,
      selectedNodeKeys,
      omittedNodeKeys: ranked.map((node) => symbolKey(node.symbol)).filter((key) => !selectedNodeKeys.includes(key)),
    };
  }
}

export function repositoryGraph(root: string) {
  return new RepositoryGraph(path.resolve(root));
}
