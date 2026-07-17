import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildZip, crc32 } from "@arbor/schema";
import { FileStore } from "@arbor/store";
import { installSkill, readZipEntries } from "./install.js";

const encoder = new TextEncoder();

/** Test-only zip writer using DEFLATE — the method real archivers emit. */
function makeDeflatedZip(files: Array<{ path: string; content: string }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const entries: Array<{ name: Uint8Array; crc: number; comp: Uint8Array; size: number; offset: number }> = [];
  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const push = (...parts: Uint8Array[]) => {
    for (const p of parts) {
      chunks.push(p);
      offset += p.length;
    }
  };
  for (const f of files) {
    const name = encoder.encode(f.path);
    const data = encoder.encode(f.content);
    const comp = new Uint8Array(zlib.deflateRawSync(data));
    entries.push({ name, crc: crc32(data), comp, size: data.length, offset });
    push(u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc32(data)), u32(comp.length), u32(data.length), u16(name.length), u16(0), name, comp);
  }
  const central = offset;
  for (const e of entries) {
    push(u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(e.crc), u32(e.comp.length), u32(e.size), u16(e.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset), e.name);
  }
  push(u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(offset - central), u32(central), u16(0));
  const out = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

let dir: string;
let files: FileStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbor-install-"));
  files = new FileStore(dir);
  files.init();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readZipEntries", () => {
  it("reads STORE zips (our own writer) with nested paths", () => {
    const zip = buildZip([
      { path: "a/b/deep.md", content: "deep content" },
      { path: "top.txt", content: "top" },
    ]);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => e.path).sort()).toEqual(["a/b/deep.md", "top.txt"]);
    expect(new TextDecoder().decode(entries.find((e) => e.path === "top.txt")!.data)).toBe("top");
  });

  it("reads DEFLATE zips (what real archivers produce)", () => {
    const zip = makeDeflatedZip([{ path: "SKILL.md", content: "# hello\nrepeat repeat repeat repeat repeat" }]);
    const entries = readZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(new TextDecoder().decode(entries[0].data)).toContain("repeat repeat");
  });

  it("rejects non-zip garbage", () => {
    expect(() => readZipEntries(encoder.encode("definitely not a zip"))).toThrow(/not a zip/);
  });
});

describe("installSkill", () => {
  it("installs a Claude-style skill package zip (SKILL.md + resources, common root folder)", async () => {
    const zip = makeDeflatedZip([
      {
        path: "pdf-report/SKILL.md",
        content: "---\nname: pdf-report\ndescription: Build polished PDF reports.\n---\n\nUse the layout in template.html.",
      },
      { path: "pdf-report/template.html", content: "<html>layout</html>" },
    ]);
    const result = await installSkill(files, "pdf-report.zip", zip);
    expect(result).toMatchObject({ name: "pdf-report", kind: "package", files: 2 });

    const skills = files.listSkills();
    const pkg = skills.find((s) => s.name === "pdf-report")!;
    expect(pkg.kind).toBe("package");
    expect(pkg.text).toContain("Build polished PDF reports.");
    expect(pkg.text).toContain("template.html");
    expect(fs.existsSync(path.join(files.skillsDir, "pdf-report", "template.html"))).toBe(true);
    expect(files.hasSkill("pdf-report")).toBe(true);

    // reinstall replaces, not duplicates
    await installSkill(files, "pdf-report.zip", zip);
    expect(files.listSkills().filter((s) => s.name === "pdf-report")).toHaveLength(1);
  });

  it("a zip with one markdown file but no SKILL.md installs as a flat skill", async () => {
    const zip = makeDeflatedZip([{ path: "notes.md", content: "single doc" }]);
    const result = await installSkill(files, "notes.zip", zip);
    expect(result.kind).toBe("md");
    expect(files.listSkills().some((s) => s.name === "skill-notes")).toBe(true);
  });

  it("rejects a multi-file zip without SKILL.md", async () => {
    const zip = makeDeflatedZip([
      { path: "a.md", content: "a" },
      { path: "b.md", content: "b" },
    ]);
    await expect(installSkill(files, "bad.zip", zip)).rejects.toThrow(/SKILL\.md/);
  });

  it("extracts PDF text into a flat skill (extractor injected)", async () => {
    const result = await installSkill(files, "Playbook.pdf", encoder.encode("%PDF-fake"), {
      pdfExtractor: async () => "Step 1: pin the clock.\nStep 2: verify.",
    });
    expect(result).toMatchObject({ name: "skill-playbook", kind: "md" });
    expect(files.listSkills().find((s) => s.name === "skill-playbook")!.text).toContain("pin the clock");
    expect(files.listSkills().find((s) => s.name === "skill-playbook")!.tags).toContain("pdf");
  });

  it("rejects a PDF with no extractable text", async () => {
    await expect(
      installSkill(files, "scan.pdf", encoder.encode("%PDF-fake"), { pdfExtractor: async () => "   " }),
    ).rejects.toThrow(/no extractable text/);
  });

  it("plain markdown installs directly; binary is rejected", async () => {
    const md = await installSkill(files, "howto.md", encoder.encode("# How to\ndo the thing"));
    expect(md).toMatchObject({ name: "skill-howto", kind: "md" });
    await expect(installSkill(files, "app.exe", new Uint8Array([77, 90, 0, 3]))).rejects.toThrow(/binary/);
  });
});
