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
function changedRanges(diff: string) {
  const ranges = new Map<string, Array<{ start: number; end: number }>>();
  let file: string | undefined;
  for (const line of diff.split("\n")) {
    const diffHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffHeader) file = diffHeader[2];
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) file = header[1];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (file && hunk) {
      const newCount = Number(hunk[4] ?? 1);
      const useOldSide = newCount === 0;
      const start = Number(useOldSide ? hunk[1] : hunk[3]);
      const count = Number(useOldSide ? (hunk[2] ?? 1) : newCount);
      const current = ranges.get(file) ?? [];
      current.push({ start, end: Math.max(start, start + count - 1) });
      ranges.set(file, current);
    }
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
    const symbols = store.symbols();
    const edges = store.edges();
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
    for (const symbol of changed) nodes.set(symbolKey(symbol), { symbol, score: 130, distance: 0 });
    const resolvedEdges = edges.map((edge) => {
      const target = resolveTarget(edge, symbols);
      return target && !edge.target ? { ...edge, target: symbolKey(target), targetSymbol: target } : edge;
    });
    for (const edge of resolvedEdges) {
      const sourceChanged = changedKeys.has(edge.source);
      const targetChanged = edge.target ? changedKeys.has(edge.target) : false;
      if (!sourceChanged && !targetChanged) continue;
      const distance = sourceChanged && targetChanged ? 0 : 1;
      const score =
        edgeBaseScore(edge.kind) + (sourceChanged && targetChanged ? 30 : 0) + (edge.confidence === "exact" ? 10 : 0);
      const source = symbols.find((symbol) => symbolKey(symbol) === edge.source);
      const target = edge.target ? symbols.find((symbol) => symbolKey(symbol) === edge.target) : undefined;
      if (source) nodes.set(symbolKey(source), { symbol: source, score, distance });
      if (target) nodes.set(symbolKey(target), { symbol: target, score, distance });
      selectedEdges.push({ ...edge, sourceSymbol: source, targetSymbol: target });
    }
    const highRiskChange =
      /\b(interface|schema|serialize|deserial|auth|permission|config|transaction|async|await|lock|mutex|state|owner)\b/i.test(
        scope.diff,
      );
    if (policy?.enableHighRiskTwoHopExpansion && policy.maxHops === 2 && highRiskChange) {
      const firstHop = new Set([...nodes.keys()]);
      const selectedEdgeKeys = new Set(
        selectedEdges.map((edge) => `${edge.source}:${edge.kind}:${edge.target ?? edge.targetText}`),
      );
      for (const edge of resolvedEdges) {
        if (!firstHop.has(edge.source) && !(edge.target && firstHop.has(edge.target))) continue;
        const source = symbols.find((symbol) => symbolKey(symbol) === edge.source);
        const target = edge.target ? symbols.find((symbol) => symbolKey(symbol) === edge.target) : undefined;
        let added = false;
        for (const symbol of [source, target]) {
          if (symbol && !nodes.has(symbolKey(symbol))) {
            nodes.set(symbolKey(symbol), {
              symbol,
              score: Math.max(1, edgeBaseScore(edge.kind) - 30),
              distance: 2,
            });
            added = true;
          }
        }
        const edgeKey = `${edge.source}:${edge.kind}:${edge.target ?? edge.targetText}`;
        if (added && !selectedEdgeKeys.has(edgeKey)) {
          selectedEdges.push({ ...edge, sourceSymbol: source, targetSymbol: target });
          selectedEdgeKeys.add(edgeKey);
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
