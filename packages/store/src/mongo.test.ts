import { describe, expect, it } from "vitest";
import { MongoMemoryStore } from "./mongo.js";

const uri = process.env.ARBOR_TEST_MONGODB_URI;

/**
 * Integration test for the tier-2 adapter — runs only when a MongoDB instance
 * is provided (never in CI): set ARBOR_TEST_MONGODB_URI=mongodb://localhost:27017
 */
describe.runIf(Boolean(uri))("MongoMemoryStore (requires ARBOR_TEST_MONGODB_URI)", () => {
  it("round-trips crystallize / recall / usage / count", async () => {
    const store = await MongoMemoryStore.connect(uri!, `arbor-test-${Date.now()}`, { dbName: "arbor_test" });
    try {
      await store.crystallize({ name: "auth-clock", text: "auth token refresh depends on the fixture clock" });
      await store.crystallize({ name: "css-grid", text: "dashboard layout uses css grid" });
      expect(await store.count()).toBe(2);

      const hits = await store.recall("auth token refresh failing", 2);
      expect(hits[0].name).toBe("auth-clock");
      expect(hits[0].usage_count).toBe(1);

      const indexed = await store.listIndexed();
      expect(indexed[0]).toMatchObject({ name: "auth-clock", usage_count: 1 });

      // upsert, not duplicate
      await store.crystallize({ name: "auth-clock", text: "updated lesson" });
      expect(await store.count()).toBe(2);
    } finally {
      await store.close();
    }
  });
});
