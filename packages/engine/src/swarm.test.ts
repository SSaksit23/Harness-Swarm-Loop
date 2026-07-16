import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree, type ArborTree, type TaskSpec } from "@arbor/schema";
import { FileStore, SqliteMemoryStore } from "@arbor/store";
import { ScriptedAgent } from "./agents.js";
import { EventBus } from "./events.js";
import { runLoop, type SwarmOptions } from "./runner.js";
import { git } from "./sandbox.js";
import { ScriptedPlanner, planWithContract } from "./swarm.js";

const CHECK_BOTH_FILES = `node -e "const fs=require('fs');process.exit(fs.existsSync('a.txt') && fs.existsSync('b.txt') ? 0 : 1)"`;

const WIDE_PLAN = {
  wide: true,
  reason: "two disjoint files",
  tasks: [
    { task_id: "a", spec: "create a.txt", acceptance: "a.txt exists", files_hint: ["a.txt"] },
    { task_id: "b", spec: "create b.txt", acceptance: "b.txt exists", files_hint: ["b.txt"] },
  ],
};

/** Worker that writes `<task_id>.txt` in its lane. */
const fileWorker = (task: TaskSpec) =>
  new ScriptedAgent(
    [
      (cwd) => {
        fs.writeFileSync(path.join(cwd, `${task.task_id}.txt`), `made by ${task.task_id}`);
      },
    ],
    0.05,
  );

let dir: string;
let files: FileStore;
let memory: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-swarm-"));
  fs.writeFileSync(path.join(dir, "README.md"), "swarm test repo\n");
});

afterEach(() => {
  memory?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seedGit() {
  await git(["init", "-b", "main"], dir);
  await git(["add", "-A"], dir);
  await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "seed"], dir);
  // commit identity for later commits made by the sandbox/merges
  await git(["config", "user.email", "t@t"], dir);
  await git(["config", "user.name", "t"], dir);
}

function initStores() {
  files = new FileStore(dir);
  files.init();
  memory = new SqliteMemoryStore(files.dbPath, "swarm-test");
}

function tree(metric: string, widthHint: "auto" | "narrow" | "wide" = "auto"): ArborTree {
  return defaultTree(
    MissionLabelsSchema.parse({
      goal: "produce both files",
      metric_scope: { metric },
      width_hint: widthHint,
      budget: { max_iterations: 1, cost_ceiling_usd: 100, no_progress_window: 10 },
    }),
  );
}

function swarmOpts(planner: ScriptedPlanner): SwarmOptions {
  return { planner, makeWorker: fileWorker, maxParallel: 2 };
}

describe("swarm layer", () => {
  it("fans out to parallel task worktrees and merges results back", async () => {
    await seedGit();
    initStores();
    const planner = new ScriptedPlanner([WIDE_PLAN]);

    const result = await runLoop({
      projectDir: dir,
      tree: tree(CHECK_BOTH_FILES),
      files,
      memory,
      executor: new ScriptedAgent([], 0.25), // sequential fallback (unused)
      swarm: swarmOpts(planner),
      // sandbox defaults on: real worktree + merge path
    });

    expect(result.outcome).toBe("pass");
    expect(result.branch).toMatch(/^arbor\/run-/);
    const record = files.readTicks().at(-1)!;
    expect(record.mode).toBe("wide");
    expect(record.swarm_tasks.map((t) => [t.task_id, t.ok])).toEqual([
      ["a", true],
      ["b", true],
    ]);
    // both task results actually landed on the run branch
    const tracked = await git(["ls-tree", "-r", "--name-only", result.branch!], dir);
    expect(tracked.stdout).toContain("a.txt");
    expect(tracked.stdout).toContain("b.txt");
    // main checkout untouched, all task worktrees cleaned up
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(false);
    const worktrees = await git(["worktree", "list"], dir);
    expect(worktrees.stdout.trim().split("\n")).toHaveLength(1);
    const branches = await git(["branch", "--list", "arbor/*-t-*"], dir);
    expect(branches.stdout.trim()).toBe("");
  });

  it("a merge conflict fails that task, not the run", async () => {
    await seedGit();
    initStores();
    const conflictPlan = {
      wide: true,
      reason: "deliberate overlap",
      tasks: [
        { task_id: "c1", spec: "write conflict.txt", acceptance: "", files_hint: ["conflict.txt"] },
        { task_id: "c2", spec: "write conflict.txt too", acceptance: "", files_hint: ["conflict.txt"] },
      ],
    };
    const conflictWorker = (task: TaskSpec) =>
      new ScriptedAgent([
        (cwd) => {
          fs.writeFileSync(path.join(cwd, "conflict.txt"), `content from ${task.task_id}\n`);
        },
      ]);

    const result = await runLoop({
      projectDir: dir,
      tree: tree(`node -e "process.exit(1)"`), // verifier always fails; run halts on the iteration cap
      files,
      memory,
      executor: new ScriptedAgent([]),
      swarm: { planner: new ScriptedPlanner([conflictPlan]), makeWorker: conflictWorker, maxParallel: 2 },
    });

    expect(result.outcome).toBe("max_iterations");
    const record = files.readTicks().at(-1)!;
    expect(record.swarm_tasks.find((t) => t.task_id === "c1")!.ok).toBe(true);
    const failed = record.swarm_tasks.find((t) => t.task_id === "c2")!;
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("merge conflict");
  });

  it("degrades to sequential in-place execution without git", async () => {
    initStores(); // no seedGit — not a repo
    const planner = new ScriptedPlanner([WIDE_PLAN]);
    const result = await runLoop({
      projectDir: dir,
      tree: tree(CHECK_BOTH_FILES),
      files,
      memory,
      executor: new ScriptedAgent([]),
      swarm: swarmOpts(planner),
      sandbox: false,
    });
    expect(result.outcome).toBe("pass");
    expect(files.readTicks().at(-1)!.mode).toBe("wide");
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "b.txt"))).toBe(true);
  });

  it("contract: an invalid plan is requeued once, then accepted", async () => {
    initStores();
    const planner = new ScriptedPlanner([{ nonsense: true, tasks: "not-an-array" }, WIDE_PLAN]);
    const result = await runLoop({
      projectDir: dir,
      tree: tree(CHECK_BOTH_FILES),
      files,
      memory,
      executor: new ScriptedAgent([]),
      swarm: swarmOpts(planner),
      sandbox: false,
    });
    expect(planner.calls).toBe(2);
    expect(result.outcome).toBe("pass");
    expect(files.readTicks().at(-1)!.mode).toBe("wide");
  });

  it("contract: two invalid plans degrade the tick to sequential", async () => {
    const events = new EventBus();
    const planner = new ScriptedPlanner([{ bad: 1 }, { still: "bad" }]);
    const validated = await planWithContract(
      planner,
      { goal: "g", criteria: [], context: [], outOfScope: [], recalled: [], lastFailureSummary: null, widthHint: "auto" },
      events,
    );
    expect(planner.calls).toBe(2);
    expect(validated.requeued).toBe(true);
    expect(validated.plan.wide).toBe(false);
    expect(validated.plan.tasks).toEqual([]);
  });

  it("contract: duplicate task ids are rejected", async () => {
    const events = new EventBus();
    const dupe = {
      wide: true,
      reason: "",
      tasks: [
        { task_id: "x", spec: "one", acceptance: "", files_hint: [] },
        { task_id: "x", spec: "two", acceptance: "", files_hint: [] },
      ],
    };
    const validated = await planWithContract(
      new ScriptedPlanner([dupe]),
      { goal: "g", criteria: [], context: [], outOfScope: [], recalled: [], lastFailureSummary: null, widthHint: "auto" },
      events,
    );
    expect(validated.plan.wide).toBe(false);
  });

  it("width_hint narrow skips the planner entirely", async () => {
    initStores();
    const planner = new ScriptedPlanner([WIDE_PLAN]);
    const singleAgent = new ScriptedAgent([
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "a.txt"), "solo");
        fs.writeFileSync(path.join(cwd, "b.txt"), "solo");
      },
    ]);
    const result = await runLoop({
      projectDir: dir,
      tree: tree(CHECK_BOTH_FILES, "narrow"),
      files,
      memory,
      executor: singleAgent,
      swarm: swarmOpts(planner),
      sandbox: false,
    });
    expect(planner.calls).toBe(0);
    expect(result.outcome).toBe("pass");
    expect(files.readTicks().at(-1)!.mode).toBe("sequential");
  });
});
