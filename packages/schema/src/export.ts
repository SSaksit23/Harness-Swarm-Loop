import type { ArborTree, TreeNode } from "./tree.js";

export interface ExportFile {
  path: string;
  content: string;
}

export interface ExportAttachment {
  name: string;
  content: string;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "node";
}

function nodeMarkdown(tree: ArborTree, node: TreeNode, children: TreeNode[], attachmentNames: string[] = []): string {
  const inbound = tree.edges.filter((e) => e.to === node.id);
  const outbound = tree.edges.filter((e) => e.from === node.id);
  const lines = [
    `# ${node.label}`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| id | \`${node.id}\` |`,
    `| type | ${node.type} |`,
    `| layer | ${node.layer} |`,
    `| parent | ${node.parent ? `\`${node.parent}\`` : "—"} |`,
    ``,
    `## Config`,
    ``,
    "```json",
    JSON.stringify(node.config, null, 2),
    "```",
  ];
  if (inbound.length || outbound.length) {
    lines.push(``, `## Connections`, ``);
    for (const e of inbound) lines.push(`- ← \`${e.from}\` (${e.kind})`);
    for (const e of outbound) lines.push(`- → \`${e.to}\` (${e.kind})`);
  }
  if (children.length) {
    lines.push(``, `## Sub-nodes`, ``);
    for (const c of children) lines.push(`- [${c.label}](./${slug(c.label)}${tree.nodes.some((n) => n.parent === c.id) ? `/${slug(c.label)}.md` : ".md"})`);
  }
  if (attachmentNames.length) {
    lines.push(``, `## Attachments`, ``);
    for (const a of attachmentNames) lines.push(`- ${a}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Export the tree as a markdown folder structure: each node becomes a .md
 * file; nodes with sub-nodes become folders containing them. Uploaded
 * attachments (if provided, keyed by node id) travel alongside their node.
 * TREE.md at the root gives the mission overview; tree.json makes the export
 * re-importable.
 */
export function treeToMarkdownFiles(tree: ArborTree, attachments?: Map<string, ExportAttachment[]>): ExportFile[] {
  const files: ExportFile[] = [];
  const childrenOf = (id: string) => tree.nodes.filter((n) => n.parent === id);

  const emit = (node: TreeNode, parentDir: string) => {
    const children = childrenOf(node.id);
    const name = slug(node.label);
    const attached = attachments?.get(node.id) ?? [];
    const names = attached.map((a) => a.name);
    if (children.length) {
      const dir = parentDir ? `${parentDir}/${name}` : name;
      files.push({ path: `${dir}/${name}.md`, content: nodeMarkdown(tree, node, children, names) });
      for (const a of attached) files.push({ path: `${dir}/attachments/${a.name}`, content: a.content });
      for (const child of children) emit(child, dir);
    } else {
      const prefix = parentDir ? `${parentDir}/` : "";
      files.push({ path: `${prefix}${name}.md`, content: nodeMarkdown(tree, node, [], names) });
      for (const a of attached) files.push({ path: `${prefix}${name}-attachments/${a.name}`, content: a.content });
    }
  };
  for (const root of tree.nodes.filter((n) => n.parent === null)) emit(root, "");

  const l = tree.labels;
  files.unshift({
    path: "TREE.md",
    content:
      [
        `# ARBOR tree — ${l.goal}`,
        ``,
        `- **goal:** ${l.goal}`,
        `- **metric:** \`${l.metric_scope.metric}\` (${l.metric_scope.threshold})`,
        `- **budget:** ${l.budget.max_iterations} iterations · $${l.budget.cost_ceiling_usd} ceiling · no-progress window ${l.budget.no_progress_window}`,
        `- **trigger:** ${l.trigger} · **width hint:** ${l.width_hint}`,
        ...(l.context.length ? [`- **context:** ${l.context.join("; ")}`] : []),
        ...(l.out_of_scope.length ? [`- **out of scope:** ${l.out_of_scope.join("; ")}`] : []),
        ``,
        `## Nodes (${tree.nodes.length})`,
        ``,
        ...tree.nodes.map((n) => `- \`${n.id}\` — ${n.label} (${n.type}, ${n.layer} layer)`),
        ``,
        `Exported ${new Date().toISOString()} · re-import via tree.json`,
      ].join("\n") + "\n",
  });
  files.push({ path: "tree.json", content: JSON.stringify(tree, null, 2) + "\n" });
  return files;
}

/* ------------------------- minimal ZIP (store) ------------------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/**
 * Build an uncompressed (STORE) zip — dependency-free and readable by every
 * archiver. Good enough for markdown exports; swap for deflate if size ever
 * matters.
 */
export function buildZip(files: ExportFile[]): Uint8Array {
  interface Entry {
    nameBytes: Uint8Array;
    data: Uint8Array;
    crc: number;
    offset: number;
  }
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const entries: Entry[] = [];

  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const concat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  };

  for (const file of files) {
    const nameBytes = encoder.encode(file.path);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    entries.push({ nameBytes, data, crc, offset });
    push(
      concat(
        u32(0x04034b50), // local file header
        u16(20), // version needed
        u16(0x0800), // flags: UTF-8 names
        u16(0), // method: store
        u16(0), u16(0), // time/date
        u32(crc),
        u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0),
        nameBytes,
        data,
      ),
    );
  }

  const centralStart = offset;
  for (const e of entries) {
    push(
      concat(
        u32(0x02014b50), // central directory header
        u16(20), u16(20),
        u16(0x0800),
        u16(0),
        u16(0), u16(0),
        u32(e.crc),
        u32(e.data.length), u32(e.data.length),
        u16(e.nameBytes.length), u16(0), u16(0),
        u16(0), u16(0),
        u32(0), // external attrs
        u32(e.offset),
        e.nameBytes,
      ),
    );
  }
  const centralSize = offset - centralStart;
  push(
    concat(
      u32(0x06054b50), // end of central directory
      u16(0), u16(0),
      u16(entries.length), u16(entries.length),
      u32(centralSize),
      u32(centralStart),
      u16(0),
    ),
  );
  return concat(...chunks);
}
