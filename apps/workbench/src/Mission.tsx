import { useState } from "react";
import { api, type MissionCompileResult } from "./api.js";

const PLACEHOLDER = `Describe the mission in plain language — say what "done" means and give a budget. Example:

build a scraper for https://example.com/attractions and save every item to data/attractions.json with prices in RMB. Done when data/attractions.json exists, parses as valid JSON, and has at least 50 items each with name and price fields. Stop at $5.`;

export function Mission({ planted, currentGoal, onPlanted }: { planted: boolean; currentGoal: string | null; onPlanted: () => void }) {
  const [mission, setMission] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [result, setResult] = useState<MissionCompileResult | null>(null);
  const [labelsText, setLabelsText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [plantedMsg, setPlantedMsg] = useState<string | null>(null);
  const [planting, setPlanting] = useState(false);

  const compile = async () => {
    setCompiling(true);
    setError(null);
    setPlantedMsg(null);
    try {
      const compiled = await api.compileMission(mission);
      setResult(compiled);
      setLabelsText(JSON.stringify(compiled.labels, null, 2));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  const plant = async () => {
    let labels: unknown;
    try {
      labels = JSON.parse(labelsText);
    } catch (e) {
      setError(`labels JSON is invalid: ${(e as Error).message}`);
      return;
    }
    if (planted && !window.confirm(`This replaces the current tree ("${currentGoal ?? "…"}") — node positions and custom nodes are reset. Plant the new mission?`)) {
      return;
    }
    setPlanting(true);
    setError(null);
    try {
      const res = await api.plantMission(labels);
      setPlantedMsg(`planted ✓ — "${res.goal}". Open the canvas to review the tree, or the run console to start.`);
      onPlanted();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanting(false);
    }
  };

  return (
    <div className="mission">
      <div className="card">
        <div className="k2">1 · describe the mission in your own words</div>
        <p className="missionhint">
          Include what <b>done</b> means (something checkable — a command, a file that must exist, tests passing) and a budget
          (<i>"stop at $5"</i>). The AI turns this into the mission labels; anything it had to guess gets flagged ⚑ for your review.
        </p>
        <textarea
          className="missiontext"
          placeholder={PLACEHOLDER}
          value={mission}
          onChange={(e) => setMission(e.target.value)}
          rows={6}
        />
        <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
          <button className="btn primary" onClick={() => void compile()} disabled={compiling || !mission.trim()}>
            {compiling ? "compiling…" : "✨ compile mission with AI"}
          </button>
          {planted && <span className="savednote">current mission: “{currentGoal}”</span>}
        </div>
        {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      </div>

      {result && (
        <>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="k2">2 · review what the AI extracted {result.flagged && <span className="flagnote">— ⚑ flagged fields were guessed, check them</span>}</div>
            <table className="ticks">
              <thead>
                <tr><th>label</th><th>value</th><th>confidence</th><th>from your text</th></tr>
              </thead>
              <tbody>
                {result.report.map((row) => (
                  <tr key={row.field} className={row.needsConfirm ? "flagged" : ""}>
                    <td className="mono">{row.needsConfirm ? "⚑ " : ""}{row.field}</td>
                    <td className="mono" style={{ maxWidth: 380, overflowWrap: "anywhere" }}>{JSON.stringify(row.value)}</td>
                    <td className="mono">{Math.round(row.confidence * 100)}%</td>
                    <td>{row.source ? `“${row.source.slice(0, 60)}”` : <span className="dim">(defaulted)</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="k2">3 · adjust if needed, then plant</div>
            <textarea className="missiontext mono" value={labelsText} onChange={(e) => setLabelsText(e.target.value)} rows={12} />
            <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
              <button className="btn primary" onClick={() => void plant()} disabled={planting}>
                {planting ? "planting…" : "🌱 plant mission"}
              </button>
              {plantedMsg && <span className="savednote">{plantedMsg}</span>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
