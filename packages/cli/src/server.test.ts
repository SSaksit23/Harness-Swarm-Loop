import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { MissionLabelsSchema, buildZip, defaultTree } from "@arbor/schema";
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

  it("exports the tree as a markdown zip", async () => {
    expect((await fetch(`${base}/api/export.zip`)).status).toBe(404);
    await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plantedTree()),
    });
    const res = await fetch(`${base}/api/export.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50); // PK local header
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("TREE.md");
    expect(text).toContain("mission/harness/brief.md");
  });

  it("attachment round-trip: upload, list, export, delete", async () => {
    await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plantedTree()),
    });

    // unknown node -> 404
    expect(
      (
        await fetch(`${base}/api/nodes/nope/attachments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename: "x.md", content: "hi" }),
        })
      ).status,
    ).toBe(404);

    // binary -> 400
    const binary = await fetch(`${base}/api/nodes/brief/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "blob.bin", content: "a" + String.fromCharCode(0) + "b" }),
    });
    expect(binary.status).toBe(400);

    // upload + list
    const up = await fetch(`${base}/api/nodes/brief/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "imported notes.md", content: "# From another project\nuse the fixture clock" }),
    });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { name: string }).name).toBe("imported-notes.md");
    const list = (await (await fetch(`${base}/api/nodes/brief/attachments`)).json()) as Array<{ name: string; content: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].content).toContain("fixture clock");

    // export includes it next to the node
    const zipText = new TextDecoder("latin1").decode(await (await fetch(`${base}/api/export.zip`)).arrayBuffer());
    expect(zipText).toContain("mission/harness/brief-attachments/imported-notes.md");

    // delete
    expect((await fetch(`${base}/api/nodes/brief/attachments/imported-notes.md`, { method: "DELETE" })).status).toBe(200);
    expect((await (await fetch(`${base}/api/nodes/brief/attachments`)).json()) as unknown[]).toHaveLength(0);
    expect((await fetch(`${base}/api/nodes/brief/attachments/imported-notes.md`, { method: "DELETE" })).status).toBe(404);
  });

  it("compiles and plants a mission over the API", async () => {
    // missing text -> 400
    expect(
      (await fetch(`${base}/api/plant/compile`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))
        .status,
    ).toBe(400);

    const compiled = await fetch(`${base}/api/plant/compile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mission: "make the test suite green, stop at $4", fixture: true }),
    });
    expect(compiled.status).toBe(200);
    const result = (await compiled.json()) as { labels: Record<string, unknown>; report: unknown[]; flagged: boolean };
    expect(result.report.length).toBeGreaterThan(3);
    expect((result.labels.budget as { cost_ceiling_usd: number }).cost_ceiling_usd).toBe(4);

    // invalid labels -> 400 with issues
    const bad = await fetch(`${base}/api/plant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: { goal: "" } }),
    });
    expect(bad.status).toBe(400);

    const planted = await fetch(`${base}/api/plant`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels: result.labels }),
    });
    expect(planted.status).toBe(200);
    const status = (await (await fetch(`${base}/api/status`)).json()) as { planted: boolean; goal: string };
    expect(status.planted).toBe(true);
    expect(status.goal).toBe("make the test suite green");
  });

  it("installs a skill package zip over the API", async () => {
    const zipBytes = buildZip([
      { path: "review/SKILL.md", content: "---\nname: review\ndescription: Review checklists.\n---\n\nAlways run the suite twice." },
      { path: "review/checklist.md", content: "- clocks pinned" },
    ]);
    const res = await fetch(`${base}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "review.zip", data_base64: Buffer.from(zipBytes).toString("base64") }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ ok: true, name: "review", kind: "package" });

    const skills = (await (await fetch(`${base}/api/skills`)).json()) as Array<{ name: string; kind: string }>;
    expect(skills.find((s) => s.name === "review")).toMatchObject({ kind: "package" });

    // garbage upload -> 400 with a real message
    const bad = await fetch(`${base}/api/skills/install`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "junk.zip", data_base64: Buffer.from("not a zip").toString("base64") }),
    });
    expect(bad.status).toBe(400);
  });

  it("drafts node content via the node writer (fixture)", async () => {
    await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plantedTree()),
    });
    const res = await fetch(`${base}/api/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId: "verifier", fixture: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string };
    expect(body.text).toContain("make the check pass");
    expect(body.text).toContain("worker");
  });

  it("routes a human-gate check-in through POST /api/checkin", async () => {
    const tree = plantedTree();
    tree.labels.budget.max_iterations = 4;
    tree.nodes.push({
      id: "human_gate",
      type: "human_gate",
      layer: "loop",
      label: "human gate",
      parent: "loop",
      config: { interval_minutes: 0, timeout_minutes: 60 },
    });
    tree.edges.push({ from: "loop", to: "human_gate", kind: "data", on_schema_violation: "reject_and_requeue" });
    // vary the failure output so the no-progress stop can't fire before the gate
    tree.labels.metric_scope.metric = `node -e "console.log(Math.random()); process.exit(1)"`;
    for (const n of tree.nodes) if (n.type === "brief") n.config = {};
    await fetch(`${base}/api/tree`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tree),
    });

    // answering with nothing pending is a 409
    expect(
      (await fetch(`${base}/api/checkin`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status,
    ).toBe(409);

    const ws = new WebSocket(`ws://127.0.0.1:${arbor.port}/ws`);
    const seen: string[] = [];
    let answered = 0;
    const done = new Promise<{ outcome: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out; saw ${seen.join(",")}`)), 30_000);
      ws.on("message", (raw) => {
        const event = JSON.parse(String(raw)) as { type: string; outcome?: string };
        seen.push(event.type);
        if (event.type === "checkin") {
          // first check-in: continue; second: stop
          const action = answered++ === 0 ? "continue" : "stop";
          void fetch(`${base}/api/checkin`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action }),
          });
        }
        if (event.type === "run_end") {
          clearTimeout(timer);
          resolve({ outcome: event.outcome! });
        }
      });
      ws.on("error", reject);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    await fetch(`${base}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "mock" }),
    });
    const { outcome } = await done;
    ws.close();

    expect(outcome).toBe("human_stop");
    expect(seen.filter((t) => t === "checkin")).toHaveLength(2);
    expect(seen).toContain("checkin_result");
  });
});
