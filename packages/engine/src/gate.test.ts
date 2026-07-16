import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree, type ArborTree } from "@arbor/schema";
import { FileStore, SqliteMemoryStore } from "@arbor/store";
import { ScriptedAgent } from "./agents.js";
import type { CheckinAction, CheckinReport } from "./events.js";
import { runLoop } from "./runner.js";
import { suggestNodeText } from "./suggest.js";

const ALWAYS_FAIL = `node -e "process.exit(1)"`;

let dir: string;
let files: FileStore;
let memory: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-gate-"));
  files = new FileStore(dir);
  files.init();
  memory = new SqliteMemoryStore(files.dbPath, "gate-test");
});

afterEach(() => {
  memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Canonical tree + a human_gate node under the loop branch, interval 0 = every tick. */
function gatedTree(gateConfig: Record<string, unknown> = {}): ArborTree {
  const tree = defaultTree(
    MissionLabelsSchema.parse({
      goal: "make the check pass",
      metric_scope: { metric: ALWAYS_FAIL },
      budget: { max_iterations: 6, cost_ceiling_usd: 100, no_progress_window: 10 },
    }),
  );
  tree.nodes.push({
    id: "human_gate",
    type: "human_gate",
    layer: "loop",
    label: "human gate",
    parent: "loop",
    config: { interval_minutes: 0, timeout_minutes: 60, ...gateConfig },
  });
  tree.edges.push({ from: "loop", to: "human_gate", kind: "data", on_schema_violation: "reject_and_requeue" });
  return tree;
}

/** Agent whose failure output varies, so no-progress never fires first. */
function varyingAgent() {
  let n = 0;
  return new ScriptedAgent(
    Array.from({ length: 8 }, () => (cwd: string) => {
      fs.writeFileSync(path.join(cwd, "n.txt"), String(++n));
    }),
    0.1,
  );
}

const VARYING_FAIL = `node -e "try { console.log(require('fs').readFileSync('n.txt','utf8')) } catch {}; process.exit(1)"`;

describe("human-in-the-loop gate", () => {
  it("checks in on the interval, applies revisions, and stops on operator stop", async () => {
    const reports: CheckinReport[] = [];
    const answers: CheckinAction[] = [
      { action: "revise", note: "focus on the auth module first" },
      { action: "stop" },
    ];
    const prompts: string[] = [];

    const tree = gatedTree();
    tree.labels.metric_scope.metric = VARYING_FAIL;
    for (const n of tree.nodes) {
      if (n.type === "brief") n.config = {}; // criteria derive from labels
    }
    const agent = varyingAgent();
    const original = agent.execute.bind(agent);
    agent.execute = async (opts) => {
      prompts.push(opts.prompt);
      return original(opts);
    };

    const result = await runLoop({
      projectDir: dir,
      tree,
      files,
      memory,
      executor: agent,
      sandbox: false,
      humanGate: {
        ask: async (report) => {
          reports.push(report);
          return answers.shift() ?? { action: "continue" };
        },
      },
    });

    expect(result.outcome).toBe("human_stop");
    expect(result.ticks).toBe(2);
    expect(reports).toHaveLength(2);
    // the report carries status + next step
    expect(reports[0].last_verdict).toBe("fail");
    expect(reports[0].failing).toContain("metric");
    expect(reports[0].next).toContain("iteration 2/6");
    // the revision note reached the next tick's prompt as operator guidance
    expect(prompts[1]).toContain("focus on the auth module first");
    expect(files.readTicks().at(-1)!.loop_decision).toBe("stop_human");
  });

  it("gate timeout falls back to the configured action", async () => {
    const tree = gatedTree({ timeout_minutes: 0.001, on_timeout: "stop" });
    const result = await runLoop({
      projectDir: dir,
      tree,
      files,
      memory,
      executor: new ScriptedAgent([], 0.1),
      sandbox: false,
      humanGate: { ask: () => new Promise(() => {}) }, // operator never answers
    });
    expect(result.outcome).toBe("human_stop");
    expect(result.ticks).toBe(1);
  });

  it("a gate node without an operator channel is skipped", async () => {
    const tree = gatedTree();
    const result = await runLoop({
      projectDir: dir,
      tree,
      files,
      memory,
      executor: new ScriptedAgent([], 0.1),
      sandbox: false,
      // no humanGate option
    });
    // the iteration cap fires as usual — the gate never blocked anything
    expect(result.outcome).toBe("max_iterations");
    expect(result.ticks).toBe(6);
  });
});

describe("node writer (fixture mode)", () => {
  it("drafts content grounded in the mission and connected nodes across layers", async () => {
    const tree = gatedTree();
    const { text } = await suggestNodeText(tree, "verifier", { fixture: true });
    expect(text).toContain("make the check pass"); // mission goal
    expect(text).toContain("swarm layer");
    expect(text).toContain("worker"); // inbound neighbour
    expect(text).toContain("memory"); // crystallize edge neighbour (harness layer)
    expect(text).toContain("loop"); // gate edge neighbour (loop layer)
  });

  it("rejects unknown node ids", async () => {
    await expect(suggestNodeText(gatedTree(), "nope", { fixture: true })).rejects.toThrow('no node with id');
  });
});
