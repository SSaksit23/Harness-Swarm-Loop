import { EventEmitter } from "node:events";
import type { TickRecord, LoopDecision } from "@arbor/schema";

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
