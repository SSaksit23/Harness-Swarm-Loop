import { useEffect, useState } from "react";
import { api, type MemoryEntry } from "./api.js";

export function Library() {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.memory().then(setEntries).catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="empty">failed to load memory: {error}</div>;
  if (!entries) return <div className="empty">loading…</div>;
  if (entries.length === 0)
    return <div className="empty">no memory yet — every tick crystallizes a lesson here, and recall usage drives curation</div>;

  return (
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
  );
}
