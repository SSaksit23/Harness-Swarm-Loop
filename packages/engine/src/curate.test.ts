import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree } from "@arbor/schema";
import { FileStore, SqliteMemoryStore } from "@arbor/store";
import { ScriptedAgent } from "./agents.js";
import { curate } from "./curate.js";
import { runLoop } from "./runner.js";

let dir: string;
let files: FileStore;
let memory: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-curate-"));
  files = new FileStore(dir);
  files.init();
  memory = new SqliteMemoryStore(files.dbPath, "curate-test");
});

afterEach(async () => {
  await memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function seed(name: string, text: string, recalls: number) {
  files.writeMemoryEntry({ name, text, tags: ["auto"], source_tick: 1 });
  await memory.crystallize({ name, text, source_tick: 1 });
  for (let i = 0; i < recalls; i++) await memory.recall(text, 1);
}

describe("curate", () => {
  it("promotes lessons recalled >= 3 times into skills, exactly once", async () => {
    await seed("hot-lesson", "the auth fixture clock must be pinned before refresh tests", 3);
    await seed("cold-lesson", "some unrelated one-off note about css colors", 0);

    const first = await curate(files, memory);
    expect(first.promoted).toEqual(["skill-hot-lesson"]);
    expect(files.hasSkill("skill-hot-lesson")).toBe(true);
    expect(files.listSkills()[0].text).toContain("fixture clock");
    expect(files.listSkills()[0].text).toContain("3 recalls");

    // idempotent — a second pass promotes nothing new
    const second = await curate(files, memory);
    expect(second.promoted).toEqual([]);
    expect(second.skills_total).toBe(1);
  });

  it("surfaces stale entries and prunes them only with prune:true", async () => {
    await seed("never-used", "nobody ever recalls this", 0);

    const dryRun = await curate(files, memory, { pruneAfterDays: 0 });
    expect(dryRun.stale).toEqual(["never-used"]);
    expect(dryRun.pruned).toEqual([]);
    expect(files.listMemoryEntries()).toHaveLength(1);

    const applied = await curate(files, memory, { pruneAfterDays: 0, prune: true });
    expect(applied.pruned).toEqual(["never-used"]);
    expect(files.listMemoryEntries()).toHaveLength(0);
    expect(await memory.count()).toBe(0);
  });

  it("promoted skills get mounted into the next run's prompt", async () => {
    files.writeSkill({ name: "skill-pin-clock", text: "always pin the fixture clock first", tags: ["promoted"], source_tick: 1 });
    // an installed package skill mounts with its on-disk resource path
    files.installSkillPackage("review-pack", [
      { path: "SKILL.md", data: new TextEncoder().encode("---\ndescription: run checks twice\n---\nsee checklist.md") },
      { path: "checklist.md", data: new TextEncoder().encode("- twice") },
    ]);

    let prompt = "";
    const agent = new ScriptedAgent([
      (cwd) => {
        fs.writeFileSync(path.join(cwd, "ok.txt"), "done");
      },
    ]);
    const original = agent.execute.bind(agent);
    agent.execute = async (opts) => {
      prompt = opts.prompt;
      return original(opts);
    };

    const tree = defaultTree(
      MissionLabelsSchema.parse({
        goal: "make the check pass",
        metric_scope: { metric: `node -e "process.exit(require('fs').existsSync('ok.txt') ? 0 : 1)"` },
      }),
    );
    const result = await runLoop({ projectDir: dir, tree, files, memory, executor: agent, sandbox: false });
    expect(result.outcome).toBe("pass");
    expect(prompt).toContain("Skills (proven procedures");
    expect(prompt).toContain("always pin the fixture clock first");
    expect(prompt).toContain("run checks twice");
    expect(prompt).toContain("[full skill resources on disk:");
    expect(prompt).toContain("review-pack");
  });
});
