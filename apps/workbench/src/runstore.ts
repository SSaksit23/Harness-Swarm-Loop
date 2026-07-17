import type { TickRecord } from "@arbor/schema";
import { subscribeEvents, type CheckinReport, type WsEvent } from "./api.js";

export interface AgentRow {
  state: "idle" | "running" | "pass" | "fail" | "halted";
  task: string;
}

export interface RunSnapshot {
  agents: Array<[string, AgentRow]>;
  thoughts: Array<{ owner: string; layer: string; text: string }>;
  stage: number;
  spend: { usd: number; tokens: number; ceiling: number };
  decision: string;
  iteration: string;
  checkin: CheckinReport | null;
  liveTicks: TickRecord[];
  running: boolean;
}

/**
 * Run telemetry lives OUTSIDE React: a module-level store fed by the shared
 * websocket. Switching tabs (which unmounts the run console) or opening the
 * canvas mid-run never loses the live run — come back and it's all still
 * there. Only a full page reload starts the view fresh.
 */
const state = {
  agents: new Map<string, AgentRow>(),
  thoughts: [] as Array<{ owner: string; layer: string; text: string }>,
  stage: 0,
  spend: { usd: 0, tokens: 0, ceiling: 10 },
  decision: "not started",
  iteration: "–",
  checkin: null as CheckinReport | null,
  liveTicks: [] as TickRecord[],
  running: false,
};

let snapshot: RunSnapshot = buildSnapshot();
const listeners = new Set<() => void>();
let started = false;

function buildSnapshot(): RunSnapshot {
  return {
    agents: [...state.agents.entries()],
    thoughts: [...state.thoughts],
    stage: state.stage,
    spend: { ...state.spend },
    decision: state.decision,
    iteration: state.iteration,
    checkin: state.checkin,
    liveTicks: [...state.liveTicks],
    running: state.running,
  };
}

function notify(): void {
  snapshot = buildSnapshot();
  for (const fn of listeners) fn();
}

function handleEvent(e: WsEvent): void {
  switch (e.type) {
    case "status":
      state.agents.set(e.agent, { state: e.state, task: e.task ?? "" });
      break;
    case "stage":
      state.stage = e.n;
      break;
    case "spend":
      state.spend = { usd: e.usd_total, tokens: e.tokens_total, ceiling: e.ceiling_usd };
      break;
    case "thought":
      state.thoughts = [...state.thoughts.slice(-199), { owner: e.owner, layer: e.layer, text: e.text }];
      break;
    case "decision":
      state.decision = `${e.decision} — ${e.reason}`;
      state.iteration = `${e.iteration}/${e.max_iterations}`;
      break;
    case "tick":
      state.liveTicks = [...state.liveTicks.filter((t) => t.tick !== e.record.tick), e.record].sort((a, b) => a.tick - b.tick);
      break;
    case "checkin":
      state.checkin = e.report;
      break;
    case "checkin_result":
      state.checkin = null;
      break;
    case "run_state":
      state.running = e.running;
      if (e.running) {
        state.agents = new Map();
        state.thoughts = [];
        state.stage = 0;
        state.spend = { ...state.spend, usd: 0, tokens: 0 };
        state.decision = "running";
        state.iteration = "–";
        state.liveTicks = [];
      } else {
        state.checkin = null;
      }
      break;
    case "run_end":
      state.decision = `run ${e.outcome} — ${e.ticks} ticks, $${e.spend_usd.toFixed(2)}${e.branch ? `, branch ${e.branch}` : ""}`;
      break;
    default:
      break;
  }
  notify();
}

export const runStore = {
  subscribe(fn: () => void): () => void {
    if (!started) {
      started = true;
      subscribeEvents(handleEvent);
    }
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  getSnapshot(): RunSnapshot {
    return snapshot;
  },
  setCheckinAnswered(): void {
    state.checkin = null;
    notify();
  },
};
