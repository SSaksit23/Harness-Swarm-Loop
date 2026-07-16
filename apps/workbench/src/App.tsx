import { useEffect, useState } from "react";
import { api, subscribeEvents, type StatusResponse } from "./api.js";
import { Canvas } from "./Canvas.js";
import { Telemetry } from "./Telemetry.js";
import { Library } from "./Library.js";

type Tab = "canvas" | "run" | "library";

export function App() {
  const [tab, setTab] = useState<Tab>("canvas");
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    void api.status().then(setStatus).catch(() => setStatus(null));
    return subscribeEvents((e) => {
      if (e.type === "run_state" || e.type === "run_end") {
        void api.status().then(setStatus).catch(() => undefined);
      }
    });
  }, []);

  const running = status?.running ?? false;

  return (
    <>
      <div className="topbar">
        <span className="brand">ARBOR</span>
        <nav className="tabs">
          <button className={tab === "canvas" ? "active" : ""} onClick={() => setTab("canvas")}>
            canvas
          </button>
          <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
            run console
          </button>
          <button className={tab === "library" ? "active" : ""} onClick={() => setTab("library")}>
            library
          </button>
        </nav>
        <span className="goal">{status?.goal ?? "no mission planted"}</span>
        <span className={`runlight ${running ? "on" : ""}`}>{running ? "running" : "idle"}</span>
      </div>
      <div className="main">
        {tab === "canvas" && <Canvas />}
        {tab === "run" && <Telemetry running={running} budget={status?.budget ?? null} />}
        {tab === "library" && <Library />}
      </div>
    </>
  );
}
