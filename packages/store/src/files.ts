import fs from "node:fs";
import path from "node:path";
import {
  ArborTreeSchema,
  TickRecordSchema,
  type ArborTree,
  type TickRecord,
} from "@arbor/schema";

export interface MemoryEntryFile {
  name: string;
  text: string;
  tags: string[];
  source_tick: number | null;
  created_at: string;
}

/**
 * The source of truth: a plain `arbor/` directory inside the target project.
 * Git-versionable, diffable, human-readable. The SQLite index is a rebuildable
 * projection of these files.
 */
export class FileStore {
  readonly root: string;

  constructor(readonly projectDir: string) {
    this.root = path.join(projectDir, "arbor");
  }

  get treeDir() {
    return path.join(this.root, "tree");
  }
  get ticksDir() {
    return path.join(this.root, "ticks");
  }
  get memoryDir() {
    return path.join(this.root, "memory");
  }
  get skillsDir() {
    return path.join(this.root, "skills");
  }
  get dbPath() {
    return path.join(this.root, "index.db");
  }
  private get treePath() {
    return path.join(this.treeDir, "tree.json");
  }

  init(): void {
    for (const dir of [this.treeDir, this.ticksDir, this.memoryDir, this.skillsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    // The index DB is a projection — keep it out of the target repo's history.
    const gi = path.join(this.root, ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "index.db\n");
  }

  isInitialized(): boolean {
    return fs.existsSync(this.treeDir);
  }

  hasTree(): boolean {
    return fs.existsSync(this.treePath);
  }

  writeTree(tree: ArborTree): void {
    fs.writeFileSync(this.treePath, JSON.stringify(tree, null, 2) + "\n");
  }

  readTree(): ArborTree {
    if (!this.hasTree()) {
      throw new Error(`no tree planted at ${this.treePath} — run \`arbor plant\` first`);
    }
    return ArborTreeSchema.parse(JSON.parse(fs.readFileSync(this.treePath, "utf8")));
  }

  writeTick(record: TickRecord): string {
    const file = path.join(this.ticksDir, `tick-${String(record.tick).padStart(4, "0")}.json`);
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
    return file;
  }

  readTicks(): TickRecord[] {
    if (!fs.existsSync(this.ticksDir)) return [];
    return fs
      .readdirSync(this.ticksDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => TickRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(this.ticksDir, f), "utf8"))));
  }

  nextTickNumber(): number {
    const ticks = this.readTicks();
    return ticks.length ? Math.max(...ticks.map((t) => t.tick)) + 1 : 1;
  }

  /** One fact per file, with a small frontmatter header. */
  writeMemoryEntry(entry: Omit<MemoryEntryFile, "created_at">): MemoryEntryFile {
    const full: MemoryEntryFile = { ...entry, created_at: new Date().toISOString() };
    const safe = full.name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    const body = [
      "---",
      `name: ${safe}`,
      `tags: ${full.tags.join(", ")}`,
      `source_tick: ${full.source_tick ?? ""}`,
      `created_at: ${full.created_at}`,
      "---",
      "",
      full.text,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(this.memoryDir, `${safe}.md`), body);
    return { ...full, name: safe };
  }

  listMemoryEntries(): MemoryEntryFile[] {
    if (!fs.existsSync(this.memoryDir)) return [];
    const out: MemoryEntryFile[] = [];
    for (const f of fs.readdirSync(this.memoryDir).filter((f) => f.endsWith(".md")).sort()) {
      const raw = fs.readFileSync(path.join(this.memoryDir, f), "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!m) continue;
      const meta = Object.fromEntries(
        m[1]
          .split("\n")
          .map((line) => {
            const i = line.indexOf(":");
            return i === -1 ? null : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
          })
          .filter((kv): kv is [string, string] => kv !== null),
      );
      out.push({
        name: meta.name ?? f.replace(/\.md$/, ""),
        tags: (meta.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
        source_tick: meta.source_tick ? Number(meta.source_tick) : null,
        created_at: meta.created_at ?? "",
        text: m[2].trim(),
      });
    }
    return out;
  }
}
