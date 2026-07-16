import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MissionLabelsSchema, defaultTree } from "@arbor/schema";
import { FileStore } from "@arbor/store";
import { createArborServer, type ArborServer } from "./server.js";

let dir: string;
let arbor: ArborServer;
let base: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-serve-"));
  arbor = createArborServer(dir);
  await new Promise<void>((resolve) => arbor.server.listen(0, resolve));
  base = `http://127.0.0.1:${arbor.port}`;
});

afterEach(async () => {
  await arbor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function plantedTree() {
  return defaultTree(
    MissionLabelsSchema.parse({
      goal: "make the check pass",
      metric_scope: { metric: `node -e "process.exit(1)"` },
      budget: { max_iterations: 1, cost_ceiling_usd: 5, no_progress_window: 5 },
    }),
  );
}

describe("arbor serve", () => {
  it("reports status and 404s an unplanted tree", async () => {
    const status = await (await fetch(`${base}/api/status`)).json();
    expect(status).toMatchObject({ planted: false, running: false, goal: null });
    expect((await fetch(`${base}/api/tree`)).status).toBe(404);
  });

  it("round-trips a tree with invariant advisories on save", async () => {
    const tree = plantedTree();
    const putOk = await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tree),
    });
    expect(putOk.status).toBe(200);
    expect(((await putOk.json()) as { violations: unknown[] }).violations).toEqual([]);

    const got = (await (await fetch(`${base}/api/tree`)).json()) as typeof tree;
    expect(got.labels.goal).toBe("make the check pass");

    // free wiring allowed: removing the verifier saves fine but reports rule 2
    const broken = plantedTree();
    broken.nodes = broken.nodes.filter((n) => n.type !== "verifier");
    broken.edges = broken.edges.filter((e) => e.from !== "verifier" && e.to !== "verifier");
    const putBroken = await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(broken),
    });
    expect(putBroken.status).toBe(200);
    const body = (await putBroken.json()) as { violations: Array<{ rule: number }> };
    expect(body.violations.map((v) => v.rule)).toContain(2);
  });

  it("rejects a malformed tree with schema issues", async () => {
    const res = await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodes: "nope" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues.length).toBeGreaterThan(0);
  });

  it("runs a mock loop and streams events over the websocket", async () => {
    await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plantedTree()),
    });

    const ws = new WebSocket(`ws://127.0.0.1:${arbor.port}/ws`);
    const events: Array<{ type: string }> = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; saw ${events.map((e) => e.type).join(",")}`)), 30_000);
      ws.on("message", (raw) => {
        const event = JSON.parse(String(raw)) as { type: string; running?: boolean };
        events.push(event);
        if (event.type === "run_state" && event.running === false && events.some((e) => e.type === "run_end")) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const run = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "mock" }),
    });
    expect(run.status).toBe(202);

    // a second run while one is active is refused
    const conflict = await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "mock" }),
    });
    expect(conflict.status).toBe(409);

    await done;
    ws.close();

    const types = new Set(events.map((e) => e.type));
    for (const expected of ["stage", "status", "thought", "spend", "decision", "tick", "run_end"]) {
      expect(types, `missing event type ${expected}`).toContain(expected);
    }

    const ticks = (await (await fetch(`${base}/api/ticks`)).json()) as Array<{ tick: number }>;
    expect(ticks.length).toBeGreaterThan(0);
    const memory = (await (await fetch(`${base}/api/memory`)).json()) as Array<{ usage_count: number }>;
    expect(memory.length).toBeGreaterThan(0);
  });
});
