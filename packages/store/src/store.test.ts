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
      mode: "sequential",
      swarm_tasks: [],
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
  it("crystallizes and recalls the most relevant entry", async () => {
    await mem.crystallize({ name: "auth-clock", text: "auth token refresh depends on the fixture clock being pinned" });
    await mem.crystallize({ name: "css-grid", text: "the dashboard layout uses css grid with a 12 column track" });
    await mem.crystallize({ name: "sqlite-wal", text: "sqlite works best in WAL mode for concurrent readers" });

    const hits = await mem.recall("why does the auth token refresh test fail", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].name).toBe("auth-clock");
  });

  it("bumps usage_count on recall (curation signal)", async () => {
    await mem.crystallize({ name: "auth-clock", text: "auth token refresh depends on the fixture clock" });
    await mem.recall("auth token refresh");
    const hits = await mem.recall("auth token refresh");
    expect(hits[0].usage_count).toBe(2);
    expect((await mem.listIndexed())[0]).toMatchObject({ name: "auth-clock", usage_count: 2 });
  });

  it("upserts by name instead of duplicating", async () => {
    await mem.crystallize({ name: "fact", text: "first version" });
    await mem.crystallize({ name: "fact", text: "second version" });
    expect(await mem.count()).toBe(1);
    expect((await mem.recall("version"))[0].text).toBe("second version");
  });

  it("rebuilds the index from files (DB is a projection)", async () => {
    store.writeMemoryEntry({ name: "from-file", text: "lesson recorded in a markdown file", tags: [], source_tick: null });
    await mem.crystallize({ name: "stale-db-only", text: "this should disappear on rebuild" });
    await mem.rebuildIndex(store);
    expect(await mem.count()).toBe(1);
    expect((await mem.recall("lesson markdown"))[0].name).toBe("from-file");
  });
});

describe("FileStore skills", () => {
  it("writes, lists, and detects skills like memory entries", () => {
    store.writeSkill({ name: "Fix Flaky Tests!", text: "pin the clock in fixtures", tags: ["promoted"], source_tick: 2 });
    const skills = store.listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("fix-flaky-tests-");
    expect(store.hasSkill("Fix Flaky Tests!")).toBe(true);
    expect(store.hasSkill("nope")).toBe(false);
  });

  it("deletes memory entries by name", () => {
    const entry = store.writeMemoryEntry({ name: "gone-soon", text: "x", tags: [], source_tick: null });
    expect(store.deleteMemoryEntry(entry.name)).toBe(true);
    expect(store.listMemoryEntries()).toHaveLength(0);
    expect(store.deleteMemoryEntry(entry.name)).toBe(false);
  });
});
