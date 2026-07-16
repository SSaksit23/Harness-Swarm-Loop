import type { Collection, MongoClient } from "mongodb";
import { HashEmbedding, cosine, type EmbeddingProvider } from "./embedding.js";
import type { CrystallizeInput, IndexedRow, MemoryHit, MemoryStore } from "./memory.js";
import type { FileStore } from "./files.js";

interface MemoryDoc {
  project: string;
  name: string;
  text: string;
  tags: string[];
  embedding: number[];
  source_tick: number | null;
  usage_count: number;
  last_used: string | null;
  created_at: string;
}

/**
 * Tier-2 memory store: MongoDB. The node/tick/memory records are documents
 * already, so they map 1:1 — no translation layer. Recall keeps the same
 * hybrid shape as the SQLite adapter (0.7 embedding cosine + 0.3 keyword
 * overlap, scored in-process) so it works against any mongod, not just Atlas;
 * swap the semantic leg for Atlas Vector Search when the corpus outgrows it.
 */
export class MongoMemoryStore implements MemoryStore {
  private constructor(
    private readonly client: MongoClient,
    private readonly coll: Collection<MemoryDoc>,
    private readonly project: string,
    private readonly embedder: EmbeddingProvider,
  ) {}

  static async connect(
    uri: string,
    project: string,
    opts: { dbName?: string; embedder?: EmbeddingProvider } = {},
  ): Promise<MongoMemoryStore> {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
    await client.connect();
    const coll = client.db(opts.dbName ?? "arbor").collection<MemoryDoc>("memory");
    await coll.createIndex({ project: 1, name: 1 }, { unique: true });
    return new MongoMemoryStore(client, coll, project, opts.embedder ?? new HashEmbedding());
  }

  async crystallize(entry: CrystallizeInput): Promise<number> {
    const embedding = this.embedder.embed(`${entry.name} ${entry.text}`);
    await this.coll.updateOne(
      { project: this.project, name: entry.name },
      {
        $set: {
          text: entry.text,
          tags: entry.tags ?? [],
          embedding,
          source_tick: entry.source_tick ?? null,
        },
        $setOnInsert: {
          usage_count: 0,
          last_used: null,
          created_at: new Date().toISOString(),
        },
      },
      { upsert: true },
    );
    return 0; // Mongo ids are ObjectIds; numeric row ids don't apply
  }

  async recall(query: string, k = 5): Promise<MemoryHit[]> {
    const docs = await this.coll.find({ project: this.project }).toArray();
    if (docs.length === 0) return [];

    const qVec = this.embedder.embed(query);
    const tokens = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const keyword = (text: string): number => {
      if (tokens.size === 0) return 0;
      const words = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      let hit = 0;
      for (const t of tokens) if (words.has(t)) hit++;
      return hit / tokens.size;
    };

    const scored = docs
      .map((doc, i) => ({
        id: i,
        name: doc.name,
        text: doc.text,
        tags: doc.tags,
        usage_count: doc.usage_count,
        score: 0.7 * cosine(qVec, doc.embedding) + 0.3 * keyword(doc.text),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .filter((h) => h.score > 0.01);

    if (scored.length) {
      const now = new Date().toISOString();
      await this.coll.updateMany(
        { project: this.project, name: { $in: scored.map((h) => h.name) } },
        { $inc: { usage_count: 1 }, $set: { last_used: now } },
      );
      for (const hit of scored) hit.usage_count += 1;
    }
    return scored;
  }

  async rebuildIndex(files: FileStore): Promise<void> {
    await this.coll.deleteMany({ project: this.project });
    for (const entry of files.listMemoryEntries()) {
      await this.crystallize({ name: entry.name, text: entry.text, tags: entry.tags, source_tick: entry.source_tick });
    }
  }

  async listIndexed(): Promise<IndexedRow[]> {
    const docs = await this.coll
      .find({ project: this.project })
      .sort({ usage_count: -1, name: 1 })
      .project<Pick<MemoryDoc, "name" | "usage_count" | "last_used" | "source_tick">>({
        name: 1,
        usage_count: 1,
        last_used: 1,
        source_tick: 1,
      })
      .toArray();
    return docs.map((d) => ({
      name: d.name,
      usage_count: d.usage_count,
      last_used: d.last_used,
      source_tick: d.source_tick,
    }));
  }

  async count(): Promise<number> {
    return this.coll.countDocuments({ project: this.project });
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
