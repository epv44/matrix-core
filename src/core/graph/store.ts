import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { GraphContextEdge, GraphFile, GraphFacts, GraphSnapshot, GraphSymbol } from "./types.js";
import { sha256Json } from "../hash.js";

const SCHEMA_VERSION = 1;

function hash(value: unknown): string {
  return sha256Json(value);
}

export class GraphStore {
  readonly db: Database.Database;
  constructor(readonly root: string) {
    const directory = path.join(root, ".quality");
    fs.mkdirSync(directory, { recursive: true });
    this.db = new Database(path.join(directory, "repository-graph.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, language TEXT NOT NULL, content_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, provider TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, content_hash TEXT NOT NULL, FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS edges(id INTEGER PRIMARY KEY, source_symbol_id INTEGER NOT NULL, target_symbol_id INTEGER, target_text TEXT NOT NULL, kind TEXT NOT NULL, confidence TEXT NOT NULL, provider TEXT NOT NULL, FOREIGN KEY(source_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE, FOREIGN KEY(target_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL);
      CREATE TABLE IF NOT EXISTS index_meta(id INTEGER PRIMARY KEY CHECK(id = 1), schema_version INTEGER NOT NULL, workspace_hash TEXT NOT NULL, indexed_commit TEXT, provider_versions TEXT NOT NULL, completed_at TEXT, state TEXT NOT NULL, snapshot_hash TEXT);
      CREATE INDEX IF NOT EXISTS symbols_qualified_name ON symbols(qualified_name);
      CREATE INDEX IF NOT EXISTS symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS edges_source ON edges(source_symbol_id);
      CREATE INDEX IF NOT EXISTS edges_target ON edges(target_symbol_id);
    `);
  }

  close() {
    this.db.close();
  }

  snapshot(): GraphSnapshot {
    const meta = this.db.prepare("SELECT * FROM index_meta WHERE id = 1").get() as any;
    const fileCount = (this.db.prepare("SELECT COUNT(*) AS count FROM files").get() as any)?.count ?? 0;
    return meta
      ? {
          state: meta.state,
          schemaVersion: meta.schema_version,
          workspaceHash: meta.workspace_hash,
          snapshotHash: meta.snapshot_hash,
          indexedCommit: meta.indexed_commit,
          providerVersions: JSON.parse(meta.provider_versions),
          completedAt: meta.completed_at,
          fileCount,
        }
      : {
          state: "ABSENT",
          schemaVersion: SCHEMA_VERSION,
          workspaceHash: "",
          snapshotHash: null,
          indexedCommit: null,
          providerVersions: {},
          completedAt: null,
          fileCount,
        };
  }

  setState(
    state: GraphSnapshot["state"],
    workspaceHash: string,
    indexedCommit: string | null,
    providerVersions: Record<string, string>,
  ) {
    this.db
      .prepare(
        `INSERT INTO index_meta(id, schema_version, workspace_hash, indexed_commit, provider_versions, completed_at, state, snapshot_hash)
      VALUES(1, ?, ?, ?, ?, NULL, ?, NULL) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, workspace_hash=excluded.workspace_hash, indexed_commit=excluded.indexed_commit, provider_versions=excluded.provider_versions, state=excluded.state`,
      )
      .run(SCHEMA_VERSION, workspaceHash, indexedCommit, JSON.stringify(providerVersions), state);
  }

  private insertFilesAndSymbols(facts: GraphFacts[]): Map<string, number> {
    const fileIds = new Map<string, number>();
    const insertFile = this.db.prepare("INSERT INTO files(path, language, content_hash) VALUES(?, ?, ?)");
    for (const file of facts.flatMap((fact) => fact.files))
      fileIds.set(file.path, Number(insertFile.run(file.path, file.language, file.contentHash).lastInsertRowid));

    const symbolIds = new Map<string, number>();
    const insertSymbol = this.db.prepare(
      "INSERT INTO symbols(file_id, provider, kind, name, qualified_name, start_line, end_line, content_hash) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const symbol of facts.flatMap((fact) => fact.symbols)) {
      const id = Number(
        insertSymbol.run(
          fileIds.get(symbol.file),
          symbol.provider,
          symbol.kind,
          symbol.name,
          symbol.qualifiedName,
          symbol.startLine,
          symbol.endLine,
          symbol.contentHash,
        ).lastInsertRowid,
      );
      symbolIds.set(`${symbol.file}:${symbol.qualifiedName}`, id);
    }
    return symbolIds;
  }

  private includeStoredSymbols(symbolIds: Map<string, number>): void {
    const rows = this.db
      .prepare(
        "SELECT s.id, f.path AS file, s.qualified_name AS qualifiedName FROM symbols s JOIN files f ON f.id=s.file_id",
      )
      .all() as Array<{ id: number; file: string; qualifiedName: string }>;
    for (const row of rows) symbolIds.set(`${row.file}:${row.qualifiedName}`, row.id);
  }

  private insertEdges(facts: GraphFacts[], symbolIds: Map<string, number>): void {
    const insertEdge = this.db.prepare(
      "INSERT INTO edges(source_symbol_id, target_symbol_id, target_text, kind, confidence, provider) VALUES(?, ?, ?, ?, ?, ?)",
    );
    for (const edge of facts.flatMap((fact) => fact.edges)) {
      const source = symbolIds.get(edge.source);
      if (source)
        insertEdge.run(
          source,
          edge.target ? (symbolIds.get(edge.target) ?? null) : null,
          edge.targetText,
          edge.kind,
          edge.confidence,
          edge.provider,
        );
    }
  }

  private completeSnapshot(snapshotHash: string): void {
    this.db
      .prepare("UPDATE index_meta SET completed_at=?, state='READY', snapshot_hash=? WHERE id=1")
      .run(new Date().toISOString(), snapshotHash);
  }

  replaceFacts(facts: GraphFacts[], workspaceHash: string, _indexedCommit: string | null): GraphSnapshot {
    const providerVersions = Object.fromEntries(facts.map((fact) => [fact.provider, fact.providerVersion]));
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM edges; DELETE FROM symbols; DELETE FROM files;");
      const symbolIds = this.insertFilesAndSymbols(facts);
      this.insertEdges(facts, symbolIds);
      const snapshotHash = hash({
        workspaceHash,
        providerVersions,
        files: facts.flatMap((fact) => fact.files),
        symbols: facts.flatMap((fact) => fact.symbols),
        edges: facts.flatMap((fact) => fact.edges),
      });
      this.completeSnapshot(snapshotHash);
      return snapshotHash;
    });
    tx();
    return this.snapshot();
  }

  updateFacts(
    facts: GraphFacts[],
    changedPaths: string[],
    workspaceHash: string,
    _indexedCommit: string | null,
  ): GraphSnapshot {
    const providerVersions = Object.fromEntries(facts.map((fact) => [fact.provider, fact.providerVersion]));
    const tx = this.db.transaction(() => {
      const placeholders = changedPaths.map(() => "?").join(",");
      const ids = this.db
        .prepare(`SELECT id FROM files WHERE path IN (${placeholders})`)
        .all(...changedPaths)
        .map((row: any) => row.id);
      if (ids.length) {
        const idList = ids.map(() => "?").join(",");
        this.db
          .prepare(
            `DELETE FROM edges WHERE source_symbol_id IN (SELECT id FROM symbols WHERE file_id IN (${idList})) OR target_symbol_id IN (SELECT id FROM symbols WHERE file_id IN (${idList}))`,
          )
          .run(...ids, ...ids);
        this.db.prepare(`DELETE FROM files WHERE id IN (${idList})`).run(...ids);
      }
      const symbolIds = this.insertFilesAndSymbols(facts);
      this.includeStoredSymbols(symbolIds);
      this.insertEdges(facts, symbolIds);
      const snapshotHash = hash({
        workspaceHash,
        providerVersions,
        files: this.files(),
        symbols: this.symbols(),
        edges: this.edges(),
      });
      this.completeSnapshot(snapshotHash);
    });
    tx();
    return this.snapshot();
  }

  files(): GraphFile[] {
    return this.db
      .prepare("SELECT path, language, content_hash AS contentHash FROM files ORDER BY path")
      .all() as GraphFile[];
  }
  matchesFiles(files: GraphFile[]): boolean {
    const current = this.files();
    return (
      current.length === files.length &&
      current.every(
        (file, index) =>
          file.path === files[index]?.path &&
          file.contentHash === files[index]?.contentHash &&
          file.language === files[index]?.language,
      )
    );
  }
  symbols(): GraphSymbol[] {
    return this.db
      .prepare(
        "SELECT s.id, f.path AS file, s.provider, s.kind, s.name, s.qualified_name AS qualifiedName, s.start_line AS startLine, s.end_line AS endLine, s.content_hash AS contentHash FROM symbols s JOIN files f ON f.id=s.file_id ORDER BY f.path, s.start_line, s.name",
      )
      .all() as GraphSymbol[];
  }
  edges(): GraphContextEdge[] {
    return this.db
      .prepare(
        "SELECT e.target_text AS targetText, e.kind, e.confidence, e.provider, sf.path AS sourceFile, ss.qualified_name AS sourceQualifiedName, tf.path AS targetFile, ts.qualified_name AS targetQualifiedName FROM edges e JOIN symbols ss ON ss.id=e.source_symbol_id JOIN files sf ON sf.id=ss.file_id LEFT JOIN symbols ts ON ts.id=e.target_symbol_id LEFT JOIN files tf ON tf.id=ts.file_id ORDER BY e.id",
      )
      .all()
      .map((row: any) => ({
        source: `${row.sourceFile}:${row.sourceQualifiedName}`,
        target: row.targetFile ? `${row.targetFile}:${row.targetQualifiedName}` : null,
        targetText: row.targetText,
        kind: row.kind,
        confidence: row.confidence,
        provider: row.provider,
      }));
  }
}
