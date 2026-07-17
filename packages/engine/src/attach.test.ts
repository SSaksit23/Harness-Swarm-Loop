import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree } from "@arbor/schema";
import { FileStore, SqliteMemoryStore } from "@arbor/store";
import { ScriptedAgent } from "./agents.js";
import { runLoop } from "./runner.js";
import { suggestNodeText } from "./suggest.js";

let dir: string;
let files: FileStore;
let memory: SqliteMemoryStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-attach-"));
  files = new FileStore(dir);
  files.init();
  memory = new SqliteMemoryStore(files.dbPath, "attach-test");
});

afterEach(async () => {
  await memory.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("attachments reach the agents", () => {
  it("uploaded reference material lands in the run prompt", async () => {
    files.writeAttachment("brief", "auth-notes.md", "# Auth notes\nThe refresh flow rotates tokens on every call.");

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
    expect(prompt).toContain("Uploaded reference material");
    expect(prompt).toContain("brief/auth-notes.md");
    expect(prompt).toContain("rotates tokens on every call");
  });

  it("the node writer sees the target node's uploads (fixture)", async () => {
    files.writeAttachment("verifier", "checklist.md", "verify token rotation");
    const tree = defaultTree(
      MissionLabelsSchema.parse({ goal: "green", metric_scope: { metric: "node --test" } }),
    );
    const { text } = await suggestNodeText(tree, "verifier", {
      fixture: true,
      attachments: files.attachmentsByNode(),
    });
    expect(text).toContain("Uploaded reference: checklist.md");
  });
});
