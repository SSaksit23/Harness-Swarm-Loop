import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { TickRecord } from "@arbor/schema";
import { api } from "./api.js";
import { runStore } from "./runstore.js";

const STAGES: Array<{ n: number; label: string }> = [
  { n: 1, label: "T1 load" },
  { n: 2, label: "T2 plan" },
  { n: 3, label: "T3 execute" },
  { n: 4, label: "T4 verify" },
  { n: 5, label: "T5 decide" },
  { n: 6, label: "T6 crystallize" },
];

export function Telemetry({
  running,
  budget,
  onBudgetChanged,
}: {
  running: boolean;
  budget: { max_iterations: number; cost_ceiling_usd: number } | null;
  onBudgetChanged: () => void;
}) {
  // Live run state survives tab switches — it lives in runstore, not here.
  const snap = useSyncExternalStore(runStore.subscribe, runStore.getSnapshot);
  const [diskTicks, setDiskTicks] = useState<TickRecord[]>([]);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const [reviseNote, setReviseNote] = useState("");
  const [ceilingText, setCeilingText] = useState("");
  const [itersText, setItersText] = useState("");
  const [budgetMsg, setBudgetMsg] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.ticks().then(setDiskTicks).catch(() => undefined);
    void api.status().then((s) => {
      if (s.checkin) runStore.getSnapshot(); // pending check-in arrives via ws snapshot on reload too
      setCeilingText(String(s.budget?.cost_ceiling_usd ?? ""));
      setItersText(String(s.budget?.max_iterations ?? ""));
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!snap.running && snap.decision.startsWith("run ")) {
      void api.ticks().then(setDiskTicks).catch(() => undefined);
    }
  }, [snap.running, snap.decision]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [snap.thoughts.length]);

  const ticks = [...diskTicks.filter((t) => !snap.liveTicks.some((l) => l.tick === t.tick)), ...snap.liveTicks].sort(
    (a, b) => a.tick - b.tick,
  );

  const startRun = async (mode: "mock" | "real" | "swarm") => {
    setRunMsg(null);
    try {
      await api.run(mode);
    } catch (e) {
      setRunMsg((e as Error).message);
    }
  };

  const answerCheckin = async (action: "continue" | "revise" | "stop") => {
    try {
      await api.checkin(action, action === "revise" ? reviseNote : undefined);
      runStore.setCheckinAnswered();
      setReviseNote("");
    } catch (e) {
      setRunMsg((e as Error).message);
    }
  };

  const applyBudget = async () => {
    const ceiling = Number(ceilingText);
    const iters = Math.round(Number(itersText));
    if (!Number.isFinite(ceiling) || ceiling <= 0 || !Number.isFinite(iters) || iters <= 0) {
      setBudgetMsg("ceiling and iterations must be positive numbers (invariant 3: every loop halts)");
      return;
    }
    try {
      const tree = await api.tree();
      tree.labels.budget.cost_ceiling_usd = ceiling;
      tree.labels.budget.max_iterations = iters;
      const hardStops = tree.nodes.find((n) => n.type === "hard_stops");
      if (hardStops) hardStops.config = { ...hardStops.config, cost_ceiling_usd: ceiling, max_iterations: iters };
      await api.saveTree(tree);
      setBudgetMsg(`budget updated ✓ — $${ceiling} / ${iters} iterations (takes effect on the next run)`);
      onBudgetChanged();
    } catch (e) {
      setBudgetMsg((e as Error).message);
    }
  };

  const pct = Math.min(100, (snap.spend.usd / (snap.spend.ceiling || 1)) * 100);

  return (
    <>
      {snap.checkin && (
        <div className="checkin">
          <h4>⏸ human gate — the loop is waiting for you</h4>
          <div className="row">
            iteration {snap.checkin.iteration}/{snap.checkin.max_iterations} · spend ${snap.checkin.spend_usd.toFixed(2)} of $
            {snap.checkin.ceiling_usd.toFixed(2)} · verifier {snap.checkin.last_verdict}
            {snap.checkin.failing.length > 0 && ` (failing: ${snap.checkin.failing.join(", ")})`}
          </div>
          <div className="row">next if you continue: {snap.checkin.next}</div>
          <textarea
            placeholder="optional guidance for the agent (used with “revise plan”)"
            value={reviseNote}
            onChange={(e) => setReviseNote(e.target.value)}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary" onClick={() => void answerCheckin("continue")}>▶ continue</button>
            <button className="btn" onClick={() => void answerCheckin("revise")} disabled={!reviseNote.trim()}>✎ revise plan</button>
            <button className="btn warn" onClick={() => void answerCheckin("stop")}>■ stop run</button>
          </div>
        </div>
      )}
      <div className="toolbar">
        <button className="btn" onClick={() => void startRun("mock")} disabled={running}>▶ run (mock)</button>
        <button className="btn primary" onClick={() => void startRun("real")} disabled={running}>▶ run (real agent)</button>
        <button className="btn" onClick={() => void startRun("swarm")} disabled={running}>▶ run (swarm)</button>
        {runMsg && <span className="error">{runMsg}</span>}
        {snap.running && <span className="savednote">run in progress — switching tabs won't lose it</span>}
      </div>
      <div className="telgrid">
        <div>
          <div className="card">
            <div className="k2">agents</div>
            {snap.agents.length === 0 && <div className="empty">no live run — press a run button, or watch a CLI run land here</div>}
            {snap.agents.map(([name, row]) => (
              <div className="agentrow" key={name}>
                <span className="aname">{name}</span>
                <span className={`pill ${row.state}`}>{row.state}</span>
                <span className="atask">{row.task}</span>
              </div>
            ))}
          </div>
          <div className="card">
            <div className="k2">thought stream</div>
            <div className="thoughts" ref={streamRef}>
              {snap.thoughts.length === 0 && <div className="thought">waiting for events…</div>}
              {snap.thoughts.map((t, i) => (
                <div className="thought" key={i}>
                  <b className={t.layer}>[{t.owner}]</b> {t.text}
                </div>
              ))}
            </div>
          </div>
        </div>
        <div>
          <div className="card">
            <div className="k2">overall process</div>
            <div className="stages">
              {STAGES.map((s) => (
                <span key={s.n} className={`stg ${snap.stage === s.n ? "on" : ""}`}>{s.label}</span>
              ))}
            </div>
            <div className="procline">iteration {snap.iteration === "–" && budget ? `– of ${budget.max_iterations}` : snap.iteration}</div>
            <div className="procline">{snap.decision}</div>
          </div>
          <div className="card">
            <div className="k2">token &amp; cost budget</div>
            <div className="gauge"><i className={pct > 80 ? "hot" : ""} style={{ width: `${pct}%` }} /></div>
            <div className="procline">
              ${snap.spend.usd.toFixed(2)} of ${snap.spend.ceiling.toFixed(2)} ceiling · {snap.spend.tokens.toLocaleString()} tokens · engine hard-stops at 100%
            </div>
            <div className="budgetedit">
              <label>ceiling $<input type="number" min="0.5" step="0.5" value={ceilingText} onChange={(e) => setCeilingText(e.target.value)} /></label>
              <label>iterations <input type="number" min="1" step="1" value={itersText} onChange={(e) => setItersText(e.target.value)} /></label>
              <button className="btn" onClick={() => void applyBudget()} disabled={running} title={running ? "stops are locked while a run is live" : "write the new limits into the tree"}>
                apply
              </button>
            </div>
            {budgetMsg && <div className="procline">{budgetMsg}</div>}
          </div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="k2">tokens per task (hover a segment for detail)</div>
        <TokenChart ticks={ticks} />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="k2">tick timeline</div>
        {ticks.length === 0 ? (
          <div className="empty">no ticks recorded yet</div>
        ) : (
          <table className="ticks">
            <thead>
              <tr>
                <th>#</th><th>mode</th><th>verifier</th><th>decision</th><th>tasks</th><th>spend</th><th>summary</th>
              </tr>
            </thead>
            <tbody>
              {ticks.map((t) => (
                <tr key={t.tick}>
                  <td className="mono">{t.tick}</td>
                  <td className="mono">{t.mode}</td>
                  <td><span className={`verdict ${t.verifier.verdict}`}>{t.verifier.verdict}</span></td>
                  <td className="mono">{t.loop_decision}</td>
                  <td className="mono">
                    {t.swarm_tasks.length === 0 ? "—" : t.swarm_tasks.map((s) => `${s.task_id}${s.ok ? "✓" : "✗"}`).join(" ")}
                  </td>
                  <td className="mono">${t.spend_total_usd.toFixed(2)}</td>
                  <td>{t.agent_summary.slice(0, 120) || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

const PALETTE = ["var(--swarm)", "var(--loop)", "var(--harness)", "var(--stop)"];

function TokenChart({ ticks }: { ticks: TickRecord[] }) {
  if (ticks.length === 0) return <div className="empty">no data yet</div>;
  const H = 120;
  const BAR = 34;
  const GAP = 14;
  const W = ticks.length * (BAR + GAP) + GAP;
  const totals = ticks.map((t) => Math.max(t.spend_delta.tokens, t.swarm_tasks.reduce((s, x) => s + x.tokens, 0), 1));
  const max = Math.max(...totals);

  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H + 34}`} width={W} height={H + 34} role="img" aria-label="tokens per task per tick">
        {ticks.map((t, i) => {
          const x = GAP + i * (BAR + GAP);
          const taskTokens = t.swarm_tasks.reduce((s, task) => s + task.tokens, 0);
          const total = totals[i];
          const scale = (v: number) => (v / max) * (H - 14);
          let y = H;
          const segments =
            t.swarm_tasks.length > 0
              ? [
                  ...t.swarm_tasks.map((task, j) => ({
                    label: `${task.task_id}${task.ok ? "" : " (failed)"}`,
                    tokens: task.tokens,
                    color: task.ok ? PALETTE[j % PALETTE.length] : "var(--stop)",
                  })),
                  ...(t.spend_delta.tokens > taskTokens
                    ? [{ label: "orchestrator", tokens: t.spend_delta.tokens - taskTokens, color: "var(--ink-faint)" }]
                    : []),
                ]
              : [{ label: "agent", tokens: t.spend_delta.tokens, color: "var(--swarm)" }];
          return (
            <g key={t.tick}>
              {segments.map((seg, j) => {
                const h = Math.max(2, scale(seg.tokens));
                y -= h;
                return (
                  <rect key={j} x={x} y={y} width={BAR} height={h} rx={2} fill={seg.color}>
                    <title>{`tick ${t.tick} · ${seg.label}: ${seg.tokens.toLocaleString()} tokens`}</title>
                  </rect>
                );
              })}
              <text x={x + BAR / 2} y={H + 14} textAnchor="middle" className="chartlabel">#{t.tick}</text>
              <text x={x + BAR / 2} y={H + 28} textAnchor="middle" className="chartlabel dim">
                {total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
