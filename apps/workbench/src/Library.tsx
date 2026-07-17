import { useCallback, useEffect, useRef, useState } from "react";
import { api, fileToBase64, type CurationReport, type MemoryEntry, type SkillInfo } from "./api.js";

export function Library() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [report, setReport] = useState<CurationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installMsg, setInstallMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const skillInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.memory().then(setEntries).catch((e: Error) => setError(e.message));
    api.skills().then(setSkills).catch(() => setSkills([]));
  }, []);
  useEffect(load, [load]);

  const installSkills = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    setInstallMsg(null);
    setBusy(true);
    const done: string[] = [];
    try {
      for (const file of Array.from(fileList)) {
        try {
          const result = await api.installSkill(file.name, await fileToBase64(file));
          done.push(`${result.name} (${result.kind})`);
        } catch (e) {
          setInstallMsg(`${file.name}: ${(e as Error).message}`);
        }
      }
      if (done.length) setInstallMsg(`installed: ${done.join(", ")}`);
      load();
    } finally {
      setBusy(false);
    }
  };

  const runCurate = async (prune: boolean) => {
    setBusy(true);
    try {
      setReport(await api.curate(prune));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="empty">failed to load library: {error}</div>;
  if (!entries) return <div className="empty">loading…</div>;

  return (
    <>
      <div className="toolbar">
        <input
          ref={skillInputRef}
          type="file"
          multiple
          accept=".zip,.pdf,.md,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            void installSkills(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          className="btn primary"
          onClick={() => skillInputRef.current?.click()}
          disabled={busy}
          title="install a skill like on Claude: a .zip package containing SKILL.md, a .pdf (text extracted), or a plain .md/.txt"
        >
          ⇪ install skill (.zip / .pdf / .md)
        </button>
        <button className="btn" onClick={() => void runCurate(false)} disabled={busy}>
          ♻ curate (promote repeated lessons to skills)
        </button>
        <button className="btn warn" onClick={() => void runCurate(true)} disabled={busy} title="also delete never-recalled entries older than 14 days">
          ♻ curate + prune
        </button>
        {installMsg && <span className="savednote">{installMsg}</span>}
        {report && (
          <span className="savednote">
            {report.promoted.length ? `promoted: ${report.promoted.join(", ")}` : "no new skills"}
            {report.pruned.length ? ` · pruned: ${report.pruned.length}` : ""}
            {report.stale.length ? ` · stale: ${report.stale.length}` : ""}
          </span>
        )}
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="k2">skills — proven procedures, mounted into every run</div>
        {skills.length === 0 ? (
          <div className="empty">no skills yet — lessons recalled 3+ times get promoted here by curation</div>
        ) : (
          <div className="memgrid">
            {skills.map((s) => (
              <div className="memcard" key={s.name}>
                <div className="name">{s.name}</div>
                <div className="meta">
                  <span className="usage">{s.kind === "package" ? "📦 package" : "md"}</span>
                  {s.tags.length > 0 && ` · ${s.tags.join(", ")}`}
                  {s.source_tick !== null && ` · tick ${s.source_tick}`}
                </div>
                <div className="text">{s.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="k2">memory — one lesson per tick, recall count is the curation signal</div>
        {entries.length === 0 ? (
          <div className="empty">no memory yet — every tick crystallizes a lesson here</div>
        ) : (
          <div className="memgrid">
            {entries.map((e) => (
              <div className="memcard" key={e.name}>
                <div className="name">{e.name}</div>
                <div className="meta">
                  <span className="usage">recalled ×{e.usage_count}</span>
                  {" · "}tick {e.source_tick ?? "—"}
                  {e.tags.length > 0 && ` · ${e.tags.join(", ")}`}
                </div>
                <div className="text">{e.text}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
