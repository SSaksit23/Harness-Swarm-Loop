import { describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree } from "./index.js";
import { buildZip, crc32, treeToMarkdownFiles } from "./export.js";

const tree = defaultTree(
  MissionLabelsSchema.parse({ goal: "green tests", metric_scope: { metric: "node --test" } }),
);

describe("markdown export", () => {
  it("mirrors the tree as folders of markdown files", () => {
    const files = treeToMarkdownFiles(tree);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("TREE.md");
    expect(paths).toContain("tree.json");
    // root is a folder (it has children), leaves are plain files inside it
    expect(paths).toContain("mission/mission.md");
    expect(paths).toContain("mission/harness/harness.md");
    expect(paths).toContain("mission/harness/brief.md");
    expect(paths).toContain("mission/swarm/verifier.md");
    expect(paths).toContain("mission/loop/hard-stops.md");
    // every node got exactly one file (+2 for TREE.md / tree.json)
    expect(files).toHaveLength(tree.nodes.length + 2);
    const brief = files.find((f) => f.path === "mission/harness/brief.md")!;
    expect(brief.content).toContain("success_criteria");
    expect(brief.content).toContain("← `harness` (data)");
  });
});

describe("zip builder", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("produces a structurally valid STORE zip", () => {
    const files = treeToMarkdownFiles(tree);
    const zip = buildZip(files);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // first local header signature
    expect(view.getUint32(0, true)).toBe(0x04034b50);

    // end of central directory: last 22 bytes (no comment)
    const eocd = zip.length - 22;
    expect(view.getUint32(eocd, true)).toBe(0x06054b50);
    expect(view.getUint16(eocd + 10, true)).toBe(files.length); // total entries

    // walk local headers and recover each stored file verbatim
    let offset = 0;
    const decoder = new TextDecoder();
    const recovered = new Map<string, string>();
    for (let i = 0; i < files.length; i++) {
      expect(view.getUint32(offset, true)).toBe(0x04034b50);
      const size = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const name = decoder.decode(zip.subarray(offset + 30, offset + 30 + nameLen));
      const data = decoder.decode(zip.subarray(offset + 30 + nameLen, offset + 30 + nameLen + size));
      recovered.set(name, data);
      offset += 30 + nameLen + size;
    }
    for (const f of files) expect(recovered.get(f.path)).toBe(f.content);

    // central directory begins right after the last local entry
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
  });
});
