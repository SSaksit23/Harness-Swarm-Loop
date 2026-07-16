import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree } from "@arbor/schema";
import { FileStore } from "./files.js";
import { SqliteMemoryStore } from "./memory.js";

let dir: string;
let store: FileStore;
let mem: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-store-"));
  store = new FileStore(dir);
  store.init();
  mem = new SqliteMemoryStore(store.dbPath, "test-project");
});

afterEach(() => {
  mem.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileStore", () => {
  it("round-trips the tree", () => {
    const tree = defaultTree(
      MissionLabelsSchema.parse({ goal: "green tests", metric_scope: { metric: "node --test" } }),
    );
    store.writeTree(tree);
    const back = store.readTree();
    expect(back.labels.goal).toBe("green tests");
    expect(back.nodes.map((n) => n.id)).toContain("verifier");
  });

  it("numbers ticks sequentially and reads them back", () => {
    expect(store.nextTickNumber()).toBe(1);
    store.writeTick({
      tick: 1,
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      agent_summary: "did a thing",
      verifier: { verdict: "fail", checks: [{ criterion: "metric", ok: false, exit_code: 1, output: "boom" }] },
      loop_decision: "continue",
      spend_delta: { tokens: 100, usd: 0.5 },
      spend_total_usd: 0.5,
      crystallized: [],
    });
    expect(store.nextTickNumber()).toBe(2);
    expect(store.readTicks()[0].verifier.verdict).toBe("fail");
  });

  it("writes and parses memory entry files", () => {
    store.writeMemoryEntry({ name: "Auth Refresh Gotcha!", text: "the fixture clock matters", tags: ["auth"], source_tick: 3 });
    const entries = store.listMemoryEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("auth-refresh-gotcha-");
    expect(entries[0].text).toContain("fixture clock");
    expect(entries[0].source_tick).toBe(3);
  });
});

describe("SqliteMemoryStore", () => {
  it("crystallizes and recalls the most relevant entry", () => {
    mem.crystallize({ name: "auth-clock", text: "auth token refresh depends on the fixture clock being pinned" });
    mem.crystallize({ name: "css-grid", text: "the dashboard layout uses css grid with a 12 column track" });
    mem.crystallize({ name: "sqlite-wal", text: "sqlite works best in WAL mode for concurrent readers" });

    const hits = mem.recall("why does the auth token refresh test fail", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe("auth-clock");
  });

  it("bumps usage_count on recall (curation signal)", () => {
    mem.crystallize({ name: "auth-clock", text: "auth token refresh depends on the fixture clock" });
    mem.recall("auth token refresh");
    const hits = mem.recall("auth token refresh");
    expect(hits[0].usage_count).toBe(2);
  });

  it("upserts by name instead of duplicating", () => {
    mem.crystallize({ name: "fact", text: "first version" });
    mem.crystallize({ name: "fact", text: "second version" });
    expect(mem.count()).toBe(1);
    expect(mem.recall("version")[0].text).toBe("second version");
  });

  it("rebuilds the index from files (DB is a projection)", () => {
    store.writeMemoryEntry({ name: "from-file", text: "lesson recorded in a markdown file", tags: [], source_tick: null });
    mem.crystallize({ name: "stale-db-only", text: "this should disappear on rebuild" });
    mem.rebuildIndex(store);
    expect(mem.count()).toBe(1);
    expect(mem.recall("lesson markdown")[0].name).toBe("from-file");
  });
});
