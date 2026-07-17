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

export interface Attachment {
  name: string;
  size: number;
  content: string;
}

/** A mounted skill: flat .md (written by curation) or an installed package folder. */
export interface SkillEntry extends MemoryEntryFile {
  kind: "md" | "package";
  /** Absolute folder path for package skills — agents can read the full resources there. */
  dir?: string;
}

export const MAX_ATTACHMENT_BYTES = 262_144; // 256KB — attachments are reference text, not blobs

function safeSegment(raw: string): string {
  // last path segment, safe charset, extension preserved — used for node ids
  // and filenames alike. Split on BOTH separators explicitly: path.basename
  // is OS-dependent and ignores backslashes on Linux.
  const last = raw.split(/[\\/]/).pop() ?? "";
  const base = last
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".") // no ".." survives, ever
    .replace(/^[.-]+/, "");
  return base || "file";
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
  get attachmentsDir() {
    return path.join(this.root, "attachments");
  }
  get dbPath() {
    return path.join(this.root, "index.db");
  }
  private get treePath() {
    return path.join(this.treeDir, "tree.json");
  }

  init(): void {
    for (const dir of [this.treeDir, this.ticksDir, this.memoryDir, this.skillsDir, this.attachmentsDir]) {
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
    return this.writeEntry(this.memoryDir, entry);
  }

  listMemoryEntries(): MemoryEntryFile[] {
    return this.listEntries(this.memoryDir);
  }

  deleteMemoryEntry(name: string): boolean {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /* ---------------- per-node attachments (uploaded reference files) ---------------- */

  /**
   * Attach a text file to a node: arbor/attachments/<node-id>/<filename>.
   * Any text type is accepted; binary (NUL byte) and oversize content is
   * rejected so attachments stay promptable reference material.
   */
  writeAttachment(nodeId: string, filename: string, content: string): Attachment {
    if (content.includes("\u0000")) {
      throw new Error(`"${filename}" looks like a binary file — attachments must be text`);
    }
    const size = Buffer.byteLength(content, "utf8");
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`"${filename}" is ${Math.round(size / 1024)}KB — attachments are capped at ${MAX_ATTACHMENT_BYTES / 1024}KB`);
    }
    const dir = this.attachmentDir(nodeId);
    fs.mkdirSync(dir, { recursive: true });
    const name = safeSegment(filename);
    const target = path.resolve(dir, name);
    if (!target.startsWith(path.resolve(this.attachmentsDir))) {
      throw new Error("invalid attachment path");
    }
    fs.writeFileSync(target, content);
    return { name, size, content };
  }

  listAttachments(nodeId: string): Attachment[] {
    const dir = this.attachmentDir(nodeId);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .sort()
      .filter((f) => fs.statSync(path.join(dir, f)).isFile())
      .map((f) => {
        const content = fs.readFileSync(path.join(dir, f), "utf8");
        return { name: f, size: Buffer.byteLength(content, "utf8"), content };
      });
  }

  deleteAttachment(nodeId: string, name: string): boolean {
    const file = path.resolve(this.attachmentDir(nodeId), safeSegment(name));
    if (!file.startsWith(path.resolve(this.attachmentsDir)) || !fs.existsSync(file)) return false;
    fs.rmSync(file);
    return true;
  }

  /** Everything at once — for the export zip and prompt assembly. */
  attachmentsByNode(): Map<string, Attachment[]> {
    const out = new Map<string, Attachment[]>();
    if (!fs.existsSync(this.attachmentsDir)) return out;
    for (const nodeDir of fs.readdirSync(this.attachmentsDir).sort()) {
      if (!fs.statSync(path.join(this.attachmentsDir, nodeDir)).isDirectory()) continue;
      const list = this.listAttachments(nodeDir);
      if (list.length) out.set(nodeDir, list);
    }
    return out;
  }

  private attachmentDir(nodeId: string): string {
    return path.join(this.attachmentsDir, safeSegment(nodeId));
  }

  /** Skills: proven procedures promoted from repeated lessons. Same format as memory. */
  writeSkill(entry: Omit<MemoryEntryFile, "created_at">): MemoryEntryFile {
    return this.writeEntry(this.skillsDir, entry);
  }

  /**
   * Flat .md skills (curation output) plus installed skill packages — folders
   * containing a SKILL.md, same convention as Claude's Agent Skills.
   */
  listSkills(): SkillEntry[] {
    const flat: SkillEntry[] = this.listEntries(this.skillsDir).map((e) => ({ ...e, kind: "md" as const }));
    const packages: SkillEntry[] = [];
    if (fs.existsSync(this.skillsDir)) {
      for (const dirent of fs.readdirSync(this.skillsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const skillMd = path.join(this.skillsDir, dirent.name, "SKILL.md");
        if (!fs.existsSync(skillMd)) continue;
        const raw = fs.readFileSync(skillMd, "utf8");
        // tolerant frontmatter: Claude packages carry name/description; both optional
        const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
        let description = "";
        let body = raw;
        if (m) {
          body = m[2].trim();
          const kv = Object.fromEntries(
            m[1]
              .split(/\r?\n/)
              .map((line) => {
                const i = line.indexOf(":");
                return i === -1 ? null : [line.slice(0, i).trim(), line.slice(i + 1).trim()];
              })
              .filter((x): x is [string, string] => x !== null),
          );
          description = kv.description ?? "";
        }
        packages.push({
          name: dirent.name,
          text: description ? `${description}\n\n${body}` : body,
          tags: ["package"],
          source_tick: null,
          created_at: fs.statSync(skillMd).mtime.toISOString(),
          kind: "package",
          dir: path.resolve(this.skillsDir, dirent.name),
        });
      }
    }
    return [...flat, ...packages].sort((a, b) => a.name.localeCompare(b.name));
  }

  hasSkill(name: string): boolean {
    const safe = name.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    return fs.existsSync(path.join(this.skillsDir, `${safe}.md`)) || fs.existsSync(path.join(this.skillsDir, safe, "SKILL.md"));
  }

  /**
   * Install a skill package (Claude Agent Skills convention): a folder of
   * files under arbor/skills/<slug>/ that must include SKILL.md. Every path
   * segment is sanitized; binary resources are allowed, SKILL.md must be text.
   */
  installSkillPackage(slug: string, entries: Array<{ path: string; data: Uint8Array }>): SkillEntry {
    const safeSlug = safeSegment(slug).replace(/\.[^.]*$/, "").toLowerCase() || "skill";
    if (!entries.some((e) => e.path.split(/[\\/]/).pop()?.toLowerCase() === "skill.md")) {
      throw new Error("a skill package must contain SKILL.md");
    }
    const root = path.join(this.skillsDir, safeSlug);
    fs.rmSync(root, { recursive: true, force: true }); // reinstall replaces
    for (const entry of entries) {
      const segments = entry.path.split(/[\\/]/).filter(Boolean).map(safeSegment);
      if (!segments.length) continue;
      const target = path.resolve(root, ...segments);
      if (!target.startsWith(path.resolve(root))) throw new Error("invalid path in skill package");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    }
    const installed = this.listSkills().find((s) => s.kind === "package" && s.name === safeSlug);
    if (!installed) throw new Error("skill package install failed");
    return installed;
  }

  private writeEntry(dir: string, entry: Omit<MemoryEntryFile, "created_at">): MemoryEntryFile {
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
    fs.writeFileSync(path.join(dir, `${safe}.md`), body);
    return { ...full, name: safe };
  }

  private listEntries(dir: string): MemoryEntryFile[] {
    if (!fs.existsSync(dir)) return [];
    const out: MemoryEntryFile[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      if (!m) continue;
      const meta = Object.fromEntries(
        m[1]
          .split(/\r?\n/)
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
