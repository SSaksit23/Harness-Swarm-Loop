import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultTree, validateInvariants } from "@arbor/schema";
import { FileStore, SqliteMemoryStore } from "@arbor/store";
import { ScriptedAgent, compileLabels, runLoop } from "@arbor/engine";

const DEMO_REPO = fileURLToPath(new URL("../../../examples/demo-repo", import.meta.url));

let dir: string;
let files: FileStore;
let memory: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-e2e-"));
  fs.cpSync(DEMO_REPO, dir, { recursive: true });
  files = new FileStore(dir);
  files.init();
  memory = new SqliteMemoryStore(files.dbPath, "e2e");
});

afterEach(() => {
  memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The scripted "fix": correct the deliberate bug in sum.js. */
function fixSum(cwd: string) {
  const file = path.join(cwd, "sum.js");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("return a - b;", "return a + b;"));
}

describe("e2e: plant + run on the demo repo", () => {
  it("compiles a mission, fixes the failing test, halts on pass, and remembers", async () => {
    // plant (offline label compiler; "node --test" is its default metric)
    const { labels } = await compileLabels("make the test suite green, stop at $5", { fixture: true });
    expect(labels.budget.cost_ceiling_usd).toBe(5);
    const tree = defaultTree(labels);
    expect(validateInvariants(tree)).toEqual([]);
    files.writeTree(tree);

    // run: tick 1 does nothing (verifier fails), tick 2 applies the fix
    const result = await runLoop({
      projectDir: dir,
      tree: files.readTree(),
      files,
      memory,
      executor: new ScriptedAgent([() => {}, fixSum], 0.4),
      sandbox: false,
    });

    expect(result.outcome).toBe("pass");
    expect(result.ticks).toBe(2);
    expect(fs.readFileSync(path.join(dir, "sum.js"), "utf8")).toContain("a + b");

    const ticks = files.readTicks();
    expect(ticks).toHaveLength(2);
    expect(ticks[0].verifier.verdict).toBe("fail");
    expect(ticks[1].verifier.verdict).toBe("pass");
    expect(ticks[1].spend_total_usd).toBeCloseTo(0.8);
    expect(ticks[1].crystallized.length).toBeGreaterThan(0);

    // a second, similar mission recalls the crystallized lesson
    const hits = await memory.recall("make the test suite green");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("test suite green");
  });

  it("negative: an impossible goal halts on a hard stop and never exceeds the ceiling", async () => {
    const { labels } = await compileLabels("make the test suite green", { fixture: true });
    labels.metric_scope.metric = "node -e \"process.exit(1)\""; // can never pass
    labels.budget = { max_iterations: 4, cost_ceiling_usd: 1, no_progress_window: 2 };
    files.writeTree(defaultTree(labels));

    const result = await runLoop({
      projectDir: dir,
      tree: files.readTree(),
      files,
      memory,
      executor: new ScriptedAgent([], 0.4), // noop agent: identical failures
      sandbox: false,
    });

    // identical failure twice -> no-progress stop fires before iteration or cost caps
    expect(result.outcome).toBe("no_progress");
    expect(result.ticks).toBe(2);
    expect(result.spendUsd).toBeLessThanOrEqual(1);
    const last = files.readTicks().at(-1)!;
    expect(last.loop_decision).toBe("stop_no_progress");
    // and the run still taught something
    expect(files.listMemoryEntries().length).toBe(2);
  });
});
