import type { FileStore } from "./files.js";
import type { MemoryStore } from "./memory.js";
import { SqliteMemoryStore } from "./memory.js";

/**
 * Open the configured memory store. Default is the embedded SQLite index
 * (zero setup); set ARBOR_MONGODB_URI to move the memory tier to MongoDB —
 * the files under arbor/ stay the source of truth either way.
 */
export async function openMemoryStore(files: FileStore, project: string): Promise<MemoryStore> {
  const uri = process.env.ARBOR_MONGODB_URI;
  if (uri) {
    const { MongoMemoryStore } = await import("./mongo.js");
    return MongoMemoryStore.connect(uri, project, { dbName: process.env.ARBOR_MONGODB_DB });
  }
  return new SqliteMemoryStore(files.dbPath, project);
}
