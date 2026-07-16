import { z } from "zod";

/**
 * A single checkable success criterion. `check` is a shell command run by the
 * verifier inside the sandbox; the criterion passes when the command exits 0.
 */
export const SuccessCriterionSchema = z.object({
  id: z.string().min(1),
  check: z.string().min(1),
  pass_when: z.string().default("exit 0"),
});
export type SuccessCriterion = z.infer<typeof SuccessCriterionSchema>;

/**
 * The safety envelope. Defaults are conservative and finite — omitted values
 * never fall back to unlimited (invariant 3).
 */
export const BudgetSchema = z.object({
  max_iterations: z.number().int().positive().finite().default(8),
  cost_ceiling_usd: z.number().positive().finite().default(10),
  no_progress_window: z.number().int().positive().finite().default(2),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** What counts, over what surface — feeds the verifier's rubric. */
export const MetricScopeSchema = z.object({
  /** Shell command whose exit code decides pass/fail, e.g. "npm test". */
  metric: z.string().min(1),
  threshold: z.string().default("exit 0"),
  /** Paths/packages the run is scoped to (informational for the agent). */
  surface: z.array(z.string()).default([]),
});
export type MetricScope = z.infer<typeof MetricScopeSchema>;

/**
 * The labels planted on the Mission Root. Every field becomes a constraint
 * somewhere in the tree.
 */
export const MissionLabelsSchema = z.object({
  goal: z.string().min(1),
  context: z.array(z.string()).default([]),
  out_of_scope: z.array(z.string()).default([]),
  metric_scope: MetricScopeSchema,
  budget: BudgetSchema.default({}),
  trigger: z.enum(["manual", "cron", "event"]).default("manual"),
  width_hint: z.enum(["auto", "narrow", "wide"]).default("auto"),
});
export type MissionLabels = z.infer<typeof MissionLabelsSchema>;

/** Derive the verifier's criteria from the mission labels. */
export function criteriaFromLabels(labels: MissionLabels): SuccessCriterion[] {
  return [
    {
      id: "metric",
      check: labels.metric_scope.metric,
      pass_when: labels.metric_scope.threshold || "exit 0",
    },
  ];
}
