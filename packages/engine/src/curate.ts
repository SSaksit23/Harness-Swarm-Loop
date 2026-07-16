import type { FileStore, MemoryStore } from "@arbor/store";

export interface CurateOptions {
  /** A lesson recalled at least this many times becomes a skill. */
  minUsageForSkill?: number;
  /** Delete never-recalled memory entries older than this many days. */
  pruneAfterDays?: number;
  /** Actually delete stale entries (otherwise they are only reported). */
  prune?: boolean;
}

export interface CurationReport {
  memory_entries: number;
  skills_total: number;
  promoted: string[];
  stale: string[];
  pruned: string[];
}

/**
 * The compounding pass from the spec: repeated work is promoted into skills,
 * dead weight is surfaced (and optionally pruned). Usage counts — bumped on
 * every recall — are the evidence; promotion threshold defaults to 3 recalls.
 */
export async function curate(files: FileStore, memory: MemoryStore, opts: CurateOptions = {}): Promise<CurationReport> {
  const minUsage = opts.minUsageForSkill ?? 3;
  const pruneAfterDays = opts.pruneAfterDays ?? 14;

  const indexed = await memory.listIndexed();
  const byName = new Map(files.listMemoryEntries().map((e) => [e.name, e]));
  const promoted: string[] = [];
  const stale: string[] = [];
  const pruned: string[] = [];

  for (const row of indexed) {
    const entry = byName.get(row.name);
    if (!entry) continue;

    // Promote: heavily-recalled lessons become skills mounted into every prompt.
    if (row.usage_count >= minUsage) {
      const skillName = `skill-${row.name}`;
      if (!files.hasSkill(skillName)) {
        files.writeSkill({
          name: skillName,
          text: `${entry.text}\n\n(Promoted from memory "${row.name}" after ${row.usage_count} recalls.)`,
          tags: ["promoted", ...entry.tags.filter((t) => t !== "auto")],
          source_tick: entry.source_tick,
        });
        promoted.push(skillName);
      }
      continue;
    }

    // Stale: never recalled and old enough that it clearly isn't helping.
    const ageDays = entry.created_at ? (Date.now() - Date.parse(entry.created_at)) / 86_400_000 : 0;
    if (row.usage_count === 0 && ageDays >= pruneAfterDays) {
      stale.push(row.name);
      if (opts.prune) {
        files.deleteMemoryEntry(row.name);
        pruned.push(row.name);
      }
    }
  }

  if (pruned.length) await memory.rebuildIndex(files);

  return {
    memory_entries: byName.size - pruned.length,
    skills_total: files.listSkills().length,
    promoted,
    stale: stale.filter((s) => !pruned.includes(s)),
    pruned,
  };
}
