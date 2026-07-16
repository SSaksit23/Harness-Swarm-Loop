import { z } from "zod";
import { SwarmTaskResultSchema } from "./swarm.js";

export const VerdictSchema = z.enum(["pass", "fail"]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const LoopDecisionSchema = z.enum([
  "continue",
  "stop_pass",
  "stop_max_iterations",
  "stop_no_progress",
  "stop_cost_ceiling",
  "stop_human",
]);
export type LoopDecision = z.infer<typeof LoopDecisionSchema>;

export const CheckResultSchema = z.object({
  criterion: z.string(),
  ok: z.boolean(),
  exit_code: z.number().nullable(),
  output: z.string(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** The observability unit — one written per loop tick. */
export const TickRecordSchema = z.object({
  tick: z.number().int().positive(),
  started_at: z.string(),
  ended_at: z.string(),
  mode: z.enum(["sequential", "wide"]).default("sequential"),
  swarm_tasks: z.array(SwarmTaskResultSchema).default([]),
  agent_summary: z.string().default(""),
  verifier: z.object({
    verdict: VerdictSchema,
    checks: z.array(CheckResultSchema),
  }),
  loop_decision: LoopDecisionSchema,
  spend_delta: z.object({
    tokens: z.number().nonnegative(),
    usd: z.number().nonnegative(),
  }),
  spend_total_usd: z.number().nonnegative(),
  crystallized: z.array(z.string()).default([]),
});
export type TickRecord = z.infer<typeof TickRecordSchema>;
