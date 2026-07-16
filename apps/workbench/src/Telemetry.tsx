import { useEffect, useRef, useState } from "react";
import type { TickRecord } from "@arbor/schema";
import { api, subscribeEvents, type WsEvent } from "./api.js";

interface AgentRow {
  state: "idle" | "running" | "pass" | "fail" | "halted";
  task: string;
}

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
}: {
  running: boolean;
  budget: { max_iterations: number; cost_ceiling_usd: number } | null;
}) {
  const [agents, setAgents] = useState<Map<string, AgentRow>>(new Map());
  const [stage, setStage] = useState(0);
  const [spend, setSpend] = useState({ usd: 0, tokens: 0, ceiling: budget?.cost_ceiling_usd ?? 10 });
  const [decision, setDecision] = useState("not started");
  const [iteration, setIteration] = useState<string>("–");
  const [thoughts, setThoughts] = useState<Array<{ owner: string; layer: string; text: string }>>([]);
  const [ticks, setTicks] = useState<TickRecord[]>([]);
  const [runMsg, setRunMsg] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.ticks().then(setTicks).catch(() => undefined);
  }, []);

  // Subscribe directly to the shared feed — one handler call per event frame,
  // so nothing coalesces away under React state batching.
  useEffect(() => subscribeEvents(handleEvent), []);

  function handleEvent(e: WsEvent): void {
    switch (e.type) {
      case "status":
        setAgents((prev) => new Map(prev).set(e.agent, { state: e.state, task: e.task ?? "" }));
        break;
      case "stage":
        setStage(e.n);
        break;
      case "spend":
        setSpend({ usd: e.usd_total, tokens: e.tokens_total, ceiling: e.ceiling_usd });
        break;
      case "thought":
        setThoughts((prev) => [...prev.slice(-199), { owner: e.owner, layer: e.layer, text: e.text }]);
        break;
      case "decision":
        setDecision(`${e.decision} — ${e.reason}`);
        setIteration(`${e.iteration}/${e.max_iterations}`);
        break;
      case "tick":
        setTicks((prev) => [...prev.filter((t) => t.tick !== e.record.tick), e.record].sort((a, b) => a.tick - b.tick));
        break;
      case "run_state":
        if (e.running) {
          setAgents(new Map());
          setThoughts([]);
          setStage(0);
          setSpend((s) => ({ ...s, usd: 0, tokens: 0 }));
          setDecision("running");
          setRunMsg(null);
        }
        break;
      case "run_end":
        setDecision(`run ${e.outcome} — ${e.ticks} ticks, $${e.spend_usd.toFixed(2)}${e.branch ? `, branch ${e.branch}` : ""}`);
        void api.ticks().then(setTicks).catch(() => undefined);
        break;
      case "run_error":
        setRunMsg(e.message);
        break;
      default:
        break;
    }
  }

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [thoughts]);

  const startRun = async (mode: "mock" | "real" | "swarm") => {
    setRunMsg(null);
    try {
      await api.run(mode);
    } catch (e) {
      setRunMsg((e as Error).message);
    }
  };

  const pct = Math.min(100, (spend.usd / (spend.ceiling || 1)) * 100);

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={() => void startRun("mock")} disabled={running}>▶ run (mock)</button>
        <button className="btn primary" onClick={() => void startRun("real")} disabled={running}>▶ run (real agent)</button>
        <button className="btn" onClick={() => void startRun("swarm")} disabled={running}>▶ run (swarm)</button>
        {runMsg && <span className="error">{runMsg}</span>}
      </div>
      <div className="telgrid">
        <div>
          <div className="card">
            <div className="k2">agents</div>
            {agents.size === 0 && <div className="empty">no live run — press a run button, or watch a CLI run land here</div>}
            {[...agents.entries()].map(([name, row]) => (
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
              {thoughts.length === 0 && <div className="thought">waiting for events…</div>}
              {thoughts.map((t, i) => (
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
                <span key={s.n} className={`stg ${stage === s.n ? "on" : ""}`}>{s.label}</span>
              ))}
            </div>
            <div className="procline">iteration {iteration === "–" && budget ? `– of ${budget.max_iterations}` : iteration}</div>
            <div className="procline">{decision}</div>
          </div>
          <div className="card">
            <div className="k2">token &amp; cost budget</div>
            <div className="gauge"><i className={pct > 80 ? "hot" : ""} style={{ width: `${pct}%` }} /></div>
            <div className="procline">
              ${spend.usd.toFixed(2)} of ${spend.ceiling.toFixed(2)} ceiling · {spend.tokens.toLocaleString()} tokens · engine hard-stops at 100%
            </div>
          </div>
        </div>
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
