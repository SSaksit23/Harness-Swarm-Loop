import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree, type ArborTree } from "@arbor/schema";
import { FileStore, SqliteMemoryStore } from "@arbor/store";
import { ScriptedAgent, type ScriptStep } from "./agents.js";
import { InvariantError, runLoop } from "./runner.js";

// Check that passes only once ok.txt exists (quoting works in cmd.exe and sh).
const CHECK_OK_FILE = `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"`;
// Check that always fails but prints n.txt, so the failure output varies per tick.
const CHECK_VARYING_FAIL = `node -e "try { console.log(require('fs').readFileSync('n.txt','utf8')) } catch {}; process.exit(1)"`;

let dir: string;
let files: FileStore;
let memory: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-run-"));
  files = new FileStore(dir);
  files.init();
  memory = new SqliteMemoryStore(files.dbPath, "test");
});

afterEach(() => {
  memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function tree(metric: string, budget: Partial<{ max_iterations: number; cost_ceiling_usd: number; no_progress_window: number }> = {}): ArborTree {
  return defaultTree(
    MissionLabelsSchema.parse({
      goal: "make the check pass",
      metric_scope: { metric },
      budget: { max_iterations: 3, cost_ceiling_usd: 100, no_progress_window: 10, ...budget },
    }),
  );
}

async function run(t: ArborTree, script: ScriptStep[], costPerTick = 0.5) {
  return runLoop({
    projectDir: dir,
    tree: t,
    files,
    memory,
    executor: new ScriptedAgent(script, costPerTick),
    sandbox: false,
  });
}

describe("runLoop", () => {
  it("stops on verifier pass and crystallizes each tick", async () => {
    const result = await run(tree(CHECK_OK_FILE), [
      () => {}, // tick 1: does nothing -> verifier fails
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "ok.txt"), "done");
      }, // tick 2: fixes it -> verifier passes
    ]);
    expect(result.outcome).toBe("pass");
    expect(result.ticks).toBe(2);
    expect(files.readTicks()).toHaveLength(2);
    expect(files.readTicks()[1].loop_decision).toBe("stop_pass");
    expect(files.listMemoryEntries()).toHaveLength(2);
    expect(memory.count()).toBe(2);
  });

  it("hard stop: halts at max_iterations when the agent never succeeds", async () => {
    let n = 0;
    const varyOutput: ScriptStep = (cwd) => {
      fs.writeFileSync(path.join(cwd, "n.txt"), String(++n));
    };
    const result = await run(tree(CHECK_VARYING_FAIL, { max_iterations: 3 }), [varyOutput, varyOutput, varyOutput, varyOutput]);
    expect(result.outcome).toBe("max_iterations");
    expect(result.ticks).toBe(3);
    expect(files.readTicks().at(-1)!.loop_decision).toBe("stop_max_iterations");
  });

  it("hard stop: detects no progress on repeated identical failures", async () => {
    // Agent does nothing, so the failing check output is byte-identical each tick.
    const result = await run(tree(CHECK_OK_FILE, { max_iterations: 8, no_progress_window: 2 }), []);
    expect(result.outcome).toBe("no_progress");
    expect(result.ticks).toBe(2);
    expect(files.readTicks().at(-1)!.loop_decision).toBe("stop_no_progress");
  });

  it("hard stop: enforces the cost ceiling outside the model", async () => {
    let n = 0;
    const varyOutput: ScriptStep = (cwd) => {
      fs.writeFileSync(path.join(cwd, "n.txt"), String(++n));
    };
    const result = await run(
      tree(CHECK_VARYING_FAIL, { max_iterations: 8, cost_ceiling_usd: 10 }),
      [varyOutput, varyOutput, varyOutput, varyOutput],
      6, // $6/tick -> $12 after tick 2, over the $10 ceiling
    );
    expect(result.outcome).toBe("cost_ceiling");
    expect(result.ticks).toBe(2);
    expect(result.spendUsd).toBe(12);
    expect(files.readTicks().at(-1)!.loop_decision).toBe("stop_cost_ceiling");
  });

  it("refuses to run a tree that violates the control invariants", async () => {
    const broken = tree(CHECK_OK_FILE);
    broken.nodes = broken.nodes.filter((node) => node.type !== "verifier");
    broken.edges = broken.edges.filter((e) => e.from !== "verifier" && e.to !== "verifier");
    await expect(run(broken, [])).rejects.toThrow(InvariantError);
    expect(files.readTicks()).toHaveLength(0);
  });

  it("feeds recalled memory into later runs", async () => {
    memory.crystallize({ name: "prior-lesson", text: "the check needs ok.txt to exist in the repo root" });
    let sawLesson = false;
    const executor = new ScriptedAgent([
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "ok.txt"), "done");
      },
    ]);
    const original = executor.execute.bind(executor);
    executor.execute = async (opts) => {
      sawLesson = opts.prompt.includes("prior-lesson");
      return original(opts);
    };
    const result = await runLoop({ projectDir: dir, tree: tree(CHECK_OK_FILE), files, memory, executor, sandbox: false });
    expect(result.outcome).toBe("pass");
    expect(sawLesson).toBe(true);
  });
});
