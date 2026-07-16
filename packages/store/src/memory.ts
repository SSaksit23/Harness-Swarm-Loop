import Database from "better-sqlite3";
import { HashEmbedding, cosine, type EmbeddingProvider } from "./embedding.js";
import type { FileStore } from "./files.js";

export interface MemoryHit {
  id: number;
  name: string;
  text: string;
  tags: string[];
  score: number;
  usage_count: number;
}

export interface CrystallizeInput {
  name: string;
  text: string;
  tags?: string[];
  source_tick?: number | null;
}

export interface MemoryStore {
  crystallize(entry: CrystallizeInput): number;
  /** Hybrid recall: 0.7 * cosine(embedding) + 0.3 * keyword score. Bumps usage on hits. */
  recall(query: string, k?: number): MemoryHit[];
  rebuildIndex(files: FileStore): void;
  count(): number;
  close(): void;
}

/**
 * Tier-1 memory store: SQLite (embedded, zero setup). Keyword recall via FTS5,
 * semantic recall via embeddings scored in-process (fine at this scale; swap
 * for sqlite-vec / a vector DB behind the same interface when it isn't).
 */
export class SqliteMemoryStore implements MemoryStore {
  private db: Database.Database;

  constructor(
    dbPath: string,
    private readonly project: string = "default",
    private readonly embedder: EmbeddingProvider = new HashEmbedding(),
  ) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        embedding TEXT NOT NULL,
        source_tick INTEGER,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(project, name)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        text, content='memory', content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory BEGIN
        INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE OF text ON memory BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
        INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  }

  crystallize(entry: CrystallizeInput): number {
    const embedding = JSON.stringify(this.embedder.embed(`${entry.name} ${entry.text}`));
    const existing = this.db
      .prepare("SELECT id FROM memory WHERE project = ? AND name = ?")
      .get(this.project, entry.name) as { id: number } | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE memory SET text = ?, tags = ?, embedding = ?, source_tick = ? WHERE id = ?")
        .run(entry.text, (entry.tags ?? []).join(","), embedding, entry.source_tick ?? null, existing.id);
      return existing.id;
    }
    const res = this.db
      .prepare(
        `INSERT INTO memory (project, name, text, tags, embedding, source_tick, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.project,
        entry.name,
        entry.text,
        (entry.tags ?? []).join(","),
        embedding,
        entry.source_tick ?? null,
        new Date().toISOString(),
      );
    return Number(res.lastInsertRowid);
  }

  recall(query: string, k = 5): MemoryHit[] {
    const rows = this.db
      .prepare("SELECT id, name, text, tags, embedding, usage_count FROM memory WHERE project = ?")
      .all(this.project) as Array<{
      id: number;
      name: string;
      text: string;
      tags: string;
      embedding: string;
      usage_count: number;
    }>;
    if (rows.length === 0) return [];

    // Keyword leg: FTS5 bm25 (lower = better) normalized to (0, 1].
    const ftsScores = new Map<number, number>();
    const tokens = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (tokens.length) {
      const match = tokens.map((t) => `"${t}"`).join(" OR ");
      try {
        const hits = this.db
          .prepare("SELECT rowid, bm25(memory_fts) AS rank FROM memory_fts WHERE memory_fts MATCH ?")
          .all(match) as Array<{ rowid: number; rank: number }>;
        for (const h of hits) ftsScores.set(h.rowid, 1 / (1 + Math.max(0, h.rank)));
      } catch {
        // an unparseable FTS query degrades to embedding-only recall
      }
    }

    const qVec = this.embedder.embed(query);
    const scored = rows
      .map((row) => {
        const sem = cosine(qVec, JSON.parse(row.embedding) as number[]);
        const kw = ftsScores.get(row.id) ?? 0;
        return {
          id: row.id,
          name: row.name,
          text: row.text,
          tags: row.tags.split(",").filter(Boolean),
          usage_count: row.usage_count,
          score: 0.7 * sem + 0.3 * kw,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((h) => h.score > 0.01);

    // Every hit bumps usage_count — the curation signal.
    const bump = this.db.prepare("UPDATE memory SET usage_count = usage_count + 1, last_used = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const hit of scored) {
      bump.run(now, hit.id);
      hit.usage_count += 1;
    }
    return scored;
  }

  /** The DB is a projection of the files — re-derive it at any time. */
  rebuildIndex(files: FileStore): void {
    this.db.prepare("DELETE FROM memory WHERE project = ?").run(this.project);
    for (const entry of files.listMemoryEntries()) {
      this.crystallize({
        name: entry.name,
        text: entry.text,
        tags: entry.tags,
        source_tick: entry.source_tick,
      });
    }
  }

  /** Index rows (name, usage, recency) — the Library screen's curation view. */
  listIndexed(): Array<{ name: string; usage_count: number; last_used: string | null; source_tick: number | null }> {
    return this.db
      .prepare(
        "SELECT name, usage_count, last_used, source_tick FROM memory WHERE project = ? ORDER BY usage_count DESC, name",
      )
      .all(this.project) as Array<{ name: string; usage_count: number; last_used: string | null; source_tick: number | null }>;
  }

  count(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM memory WHERE project = ?").get(this.project) as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
