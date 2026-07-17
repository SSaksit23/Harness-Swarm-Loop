import zlib from "node:zlib";
import path from "node:path";
import type { FileStore, SkillEntry } from "@arbor/store";

const MAX_ZIP_ENTRIES = 200;
const MAX_UNCOMPRESSED_TOTAL = 8 * 1024 * 1024; // 8MB per package
const MAX_PDF_TEXT = 200_000; // chars kept from an extracted PDF

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/**
 * Minimal zip reader for skill packages: walks the central directory and
 * supports the two methods real-world zips use — STORE (0) and DEFLATE (8,
 * via node:zlib). Zip64 and encrypted archives are rejected.
 */
export function readZipEntries(buffer: Uint8Array): ZipEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  // locate end-of-central-directory (scan backwards; comment can pad the tail)
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 22 - 65_536);
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a zip file (no end-of-central-directory record)");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count > MAX_ZIP_ENTRIES) throw new Error(`zip has ${count} entries — capped at ${MAX_ZIP_ENTRIES}`);

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let total = 0;

  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("corrupt zip: bad central directory entry");
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(buffer.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw new Error("encrypted zips are not supported");
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) throw new Error("zip64 archives are not supported");
    if (name.endsWith("/")) continue; // directory entry

    total += uncompSize;
    if (total > MAX_UNCOMPRESSED_TOTAL) throw new Error("zip contents exceed the 8MB package cap");

    // local header carries its own name/extra lengths — data starts after them
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) data = compressed.slice();
    else if (method === 8) data = new Uint8Array(zlib.inflateRawSync(compressed));
    else throw new Error(`unsupported zip compression method ${method}`);
    entries.push({ path: name, data });
  }
  return entries;
}

/** Strip a single shared top-level folder (skill-name/SKILL.md -> SKILL.md). */
function stripCommonRoot(entries: ZipEntry[]): { entries: ZipEntry[]; root: string | null } {
  const tops = new Set(entries.map((e) => e.path.split(/[\\/]/).filter(Boolean)[0] ?? ""));
  if (tops.size !== 1) return { entries, root: null };
  const root = [...tops][0];
  const allNested = entries.every((e) => e.path.split(/[\\/]/).filter(Boolean).length > 1);
  if (!allNested) return { entries, root: null };
  return {
    root,
    entries: entries.map((e) => ({ ...e, path: e.path.split(/[\\/]/).filter(Boolean).slice(1).join("/") })),
  };
}

export type PdfExtractor = (data: Uint8Array) => Promise<string>;

async function defaultPdfExtractor(data: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(data);
  const { text } = await extractText(pdf, { mergePages: true });
  return typeof text === "string" ? text : String(text ?? "");
}

export interface InstallResult {
  name: string;
  kind: SkillEntry["kind"];
  files: number;
}

/**
 * Install an uploaded skill, dispatching on file type — the same idea as
 * installing a skill on Claude:
 *  - .zip  -> skill package folder (must contain SKILL.md, Claude convention)
 *  - .pdf  -> text extracted into a flat .md skill
 *  - .md / .txt / other text -> flat .md skill
 */
export async function installSkill(
  files: FileStore,
  filename: string,
  buffer: Uint8Array,
  opts: { pdfExtractor?: PdfExtractor } = {},
): Promise<InstallResult> {
  const ext = path.extname(filename).toLowerCase();
  const stem = path.basename(filename, path.extname(filename));
  const flatName = stem.toLowerCase().startsWith("skill") ? stem : `skill-${stem}`;

  if (ext === ".zip") {
    const { entries, root } = stripCommonRoot(readZipEntries(buffer));
    const hasSkillMd = entries.some((e) => e.path.split(/[\\/]/).pop()?.toLowerCase() === "skill.md");
    if (!hasSkillMd) {
      // grace: a zip that is just one markdown file installs as a flat skill
      const mdFiles = entries.filter((e) => e.path.toLowerCase().endsWith(".md"));
      if (mdFiles.length === 1) {
        const text = new TextDecoder().decode(mdFiles[0].data);
        const saved = files.writeSkill({ name: flatName, text, tags: ["uploaded"], source_tick: null });
        return { name: saved.name, kind: "md", files: 1 };
      }
      throw new Error("skill zip must contain SKILL.md (Claude skill package format)");
    }
    // normalize SKILL.md casing so the store finds it
    const normalized = entries.map((e) =>
      e.path.split(/[\\/]/).pop()?.toLowerCase() === "skill.md"
        ? { ...e, path: e.path.replace(/[^\\/]+$/, "SKILL.md") }
        : e,
    );
    const installed = files.installSkillPackage(root ?? stem, normalized);
    return { name: installed.name, kind: "package", files: normalized.length };
  }

  if (ext === ".pdf") {
    const extract = opts.pdfExtractor ?? defaultPdfExtractor;
    const text = (await extract(buffer)).trim().slice(0, MAX_PDF_TEXT);
    if (!text) throw new Error(`no extractable text found in ${filename} (scanned/image-only PDFs are not supported)`);
    const saved = files.writeSkill({ name: flatName, text, tags: ["uploaded", "pdf"], source_tick: null });
    return { name: saved.name, kind: "md", files: 1 };
  }

  // anything else: treat as a text skill (the store rejects binary/oversize)
  const text = new TextDecoder().decode(buffer);
  if (text.includes(String.fromCharCode(0))) {
    throw new Error(`${filename}: unsupported binary file — upload .zip (skill package), .pdf, or a text file`);
  }
  const saved = files.writeSkill({ name: flatName, text, tags: ["uploaded"], source_tick: null });
  return { name: saved.name, kind: "md", files: 1 };
}
