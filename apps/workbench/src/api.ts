import type { ArborTree, TickRecord, Violation } from "@arbor/schema";

export interface CheckinReport {
  iteration: number;
  max_iterations: number;
  spend_usd: number;
  ceiling_usd: number;
  last_verdict: "pass" | "fail";
  failing: string[];
  next: string;
  interval_minutes: number;
}

export interface StatusResponse {
  planted: boolean;
  running: boolean;
  goal: string | null;
  budget: { max_iterations: number; cost_ceiling_usd: number; no_progress_window: number } | null;
  project: string;
  checkin: CheckinReport | null;
}

export interface MemoryEntry {
  name: string;
  text: string;
  tags: string[];
  source_tick: number | null;
  created_at: string;
  usage_count: number;
  last_used: string | null;
}

export type WsEvent =
  | { type: "status"; agent: string; state: "idle" | "running" | "pass" | "fail" | "halted"; task?: string }
  | { type: "thought"; owner: string; layer: string; text: string }
  | { type: "stage"; n: 1 | 2 | 3 | 4 | 5 | 6; label: string }
  | { type: "spend"; usd_total: number; tokens_total: number; ceiling_usd: number }
  | { type: "tick"; record: TickRecord }
  | { type: "decision"; decision: string; iteration: number; max_iterations: number; reason: string }
  | { type: "checkin"; report: CheckinReport }
  | { type: "checkin_result"; action: "continue" | "revise" | "stop"; note: string | null }
  | { type: "run_end"; outcome: string; ticks: number; spend_usd: number; branch: string | null }
  | { type: "run_error"; message: string }
  | { type: "run_state"; running: boolean };

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json()) as T & { error?: string; issues?: string[] };
  if (!res.ok) {
    throw new Error(body.error ? `${body.error}${body.issues ? `: ${body.issues.join("; ")}` : ""}` : `HTTP ${res.status}`);
  }
  return body;
}

export const api = {
  status: () => jsonFetch<StatusResponse>("/api/status"),
  tree: () => jsonFetch<ArborTree>("/api/tree"),
  saveTree: (tree: ArborTree) =>
    jsonFetch<{ ok: boolean; violations: Violation[] }>("/api/tree", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tree),
    }),
  ticks: () => jsonFetch<TickRecord[]>("/api/ticks"),
  memory: () => jsonFetch<MemoryEntry[]>("/api/memory"),
  run: (mode: "mock" | "real" | "swarm") =>
    jsonFetch<{ ok: boolean; error?: string }>("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  checkin: (action: "continue" | "revise" | "stop", note?: string) =>
    jsonFetch<{ ok: boolean }>("/api/checkin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, note }),
    }),
  suggest: (nodeId: string) =>
    jsonFetch<{ text: string }>("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }),
};

/**
 * One shared WebSocket, fanned out synchronously to every subscriber. Do NOT
 * funnel events through a single React state value — rapid frames coalesce
 * under batching and telemetry updates get silently dropped.
 */
const listeners = new Set<(e: WsEvent) => void>();
let socketStarted = false;

function startSocket(): void {
  if (socketStarted) return;
  socketStarted = true;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const open = () => {
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data as string) as WsEvent;
        for (const fn of listeners) fn(event);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => setTimeout(open, 1500); // auto-reconnect
  };
  open();
}

export function subscribeEvents(onEvent: (e: WsEvent) => void): () => void {
  startSocket();
  listeners.add(onEvent);
  return () => {
    listeners.delete(onEvent);
  };
}
