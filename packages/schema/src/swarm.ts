import { z } from "zod";

/**
 * The typed handoff from orchestrator to worker (edge.contract). A plan that
 * fails this schema is rejected and requeued once, then the tick degrades to
 * sequential mode — a schema violation never ships to a worker.
 */
export const TaskSpecSchema = z.object({
  task_id: z.string().min(1),
  spec: z.string().min(1),
  /** How the worker knows it's done — maps back to the success criteria. */
  acceptance: z.string().default(""),
  /** Files/areas the task expects to touch; tasks should be disjoint. */
  files_hint: z.array(z.string()).default([]),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/** The orchestrator's decision: the ceiling test result plus the split. */
export const PlanSchema = z.object({
  wide: z.boolean(),
  reason: z.string().default(""),
  tasks: z.array(TaskSpecSchema).max(8).default([]),
});
export type Plan = z.infer<typeof PlanSchema>;

/** The worker -> verifier handoff, recorded per task in the tick record. */
export const SwarmTaskResultSchema = z.object({
  task_id: z.string(),
  ok: z.boolean(),
  summary: z.string().default(""),
  usd: z.number().nonnegative().default(0),
  tokens: z.number().nonnegative().default(0),
  error: z.string().nullable().default(null),
});
export type SwarmTaskResult = z.infer<typeof SwarmTaskResultSchema>;
