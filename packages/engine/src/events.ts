import { EventEmitter } from "node:events";
import type { TickRecord, LoopDecision } from "@arbor/schema";

/** Status snapshot handed to the human at a human_gate check-in. */
export interface CheckinReport {
  iteration: number;
  max_iterations: number;
  spend_usd: number;
  ceiling_usd: number;
  last_verdict: "pass" | "fail";
  failing: string[];
  /** What the loop will do if the human says continue. */
  next: string;
  interval_minutes: number;
}

export type CheckinAction = { action: "continue" | "revise" | "stop"; note?: string };

/** The channel through which a human answers a check-in (CLI readline, UI button, ...). */
export interface HumanGate {
  ask(report: CheckinReport): Promise<CheckinAction>;
}

/**
 * The telemetry contract. These events are what the CLI renders today and what
 * the workbench UI will consume over websocket in M7: agent status, thought
 * summaries, stage tracker, token/cost spend.
 */
export type ArborEvent =
  | { type: "status"; agent: string; state: "idle" | "running" | "pass" | "fail" | "halted"; task?: string }
  | { type: "thought"; owner: string; layer: "harness" | "swarm" | "loop" | "gate"; text: string }
  | { type: "stage"; n: 1 | 2 | 3 | 4 | 5 | 6; label: string }
  | { type: "spend"; usd_total: number; tokens_total: number; ceiling_usd: number }
  | { type: "tick"; record: TickRecord }
  | { type: "decision"; decision: LoopDecision; iteration: number; max_iterations: number; reason: string }
  | { type: "checkin"; report: CheckinReport }
  | { type: "checkin_result"; action: CheckinAction["action"]; note: string | null }
  | { type: "run_end"; outcome: string; ticks: number; spend_usd: number; branch: string | null };

export class EventBus {
  private emitter = new EventEmitter();

  emit(event: ArborEvent): void {
    this.emitter.emit("event", event);
  }

  on(listener: (event: ArborEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }
}
