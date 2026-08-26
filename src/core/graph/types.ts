import type { LanguageWorkspace } from "../types.js";

export type GraphLanguage = "python" | "typescript";
export type GraphSymbolKind = "function" | "class" | "method" | "variable" | "module" | "interface" | "type" | "enum";
export type GraphEdgeKind =
  | "defines"
  | "imports"
  | "exports"
  | "calls"
  | "references"
  | "extends"
  | "implements"
  | "reads-type"
  | "producer-consumer"
  | "config"
  | "schema-user"
  | "serialization"
  | "test-reference";
export type GraphConfidence = "exact" | "syntactic" | "textual";

export interface GraphFile {
  path: string;
  language: GraphLanguage;
  contentHash: string;
}

export interface GraphSymbol {
  id?: number;
  file: string;
  provider: string;
  kind: GraphSymbolKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  contentHash: string;
}

export interface GraphEdge {
  source: string;
  target: string | null;
  targetText: string;
  kind: GraphEdgeKind;
  confidence: GraphConfidence;
  provider: string;
}

export interface GraphFacts {
  files: GraphFile[];
  symbols: GraphSymbol[];
  edges: GraphEdge[];
  provider: string;
  providerVersion: string;
}

export interface GraphSnapshot {
  state: "ABSENT" | "BUILDING" | "READY" | "STALE" | "UPDATING";
  schemaVersion: number;
  workspaceHash: string;
  snapshotHash: string | null;
  indexedCommit: string | null;
  providerVersions: Record<string, string>;
  completedAt: string | null;
  fileCount: number;
}

export interface GraphContextNode {
  symbol: GraphSymbol;
  score: number;
  distance: number;
  excerpt?: string;
}

export interface GraphContextEdge extends GraphEdge {
  sourceSymbol?: GraphSymbol;
  targetSymbol?: GraphSymbol;
}

export interface GraphContext {
  snapshot: GraphSnapshot;
  changedSymbols: GraphSymbol[];
  nodes: GraphContextNode[];
  edges: GraphContextEdge[];
  rendered: string;
  tokenEstimate: number;
  budgetTokens: number;
  selectedNodeKeys: string[];
  omittedNodeKeys: string[];
}

export interface GraphProvider {
  readonly id: string;
  readonly version: string;
  supports(workspace: LanguageWorkspace): boolean;
  indexFiles(root: string, files: GraphFile[]): Promise<GraphFacts>;
}
