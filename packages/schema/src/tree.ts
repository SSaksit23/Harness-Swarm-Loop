import { z } from "zod";
import { MissionLabelsSchema } from "./labels.js";

export const NodeTypeSchema = z.enum([
  "mission",
  "harness",
  "brief",
  "memory",
  "skills",
  "swarm",
  "orchestrator",
  "worker",
  "verifier",
  "loop",
  "contract",
  "hard_stops",
  "sandbox",
  "human_gate",
  "custom",
]);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const LayerSchema = z.enum(["root", "harness", "swarm", "loop"]);
export type Layer = z.infer<typeof LayerSchema>;

export const TreeNodeSchema = z.object({
  id: z.string().min(1),
  type: NodeTypeSchema,
  layer: LayerSchema,
  label: z.string().min(1),
  parent: z.string().nullable().default(null),
  config: z.record(z.unknown()).default({}),
});
export type TreeNode = z.infer<typeof TreeNodeSchema>;

/** Typed handoff between nodes. */
export const TreeEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["data", "gate", "mem"]).default("data"),
  on_schema_violation: z
    .enum(["reject_and_requeue", "fail_tick"])
    .default("reject_and_requeue"),
});
export type TreeEdge = z.infer<typeof TreeEdgeSchema>;

export const LoopContractSchema = z.object({
  trigger: z.enum(["manual", "cron", "event"]).default("manual"),
  scope: z.string().default("one mission per run"),
  action: z.string().default("plan -> execute -> verify"),
  stop: z.string().default("verifier pass OR any hard stop"),
  report: z.string().default("tick record -> run console + memory"),
});
export type LoopContract = z.infer<typeof LoopContractSchema>;

/** The whole persisted tree: labels + vertices + typed handoffs. */
export const ArborTreeSchema = z.object({
  version: z.literal(1).default(1),
  labels: MissionLabelsSchema,
  nodes: z.array(TreeNodeSchema),
  edges: z.array(TreeEdgeSchema),
});
export type ArborTree = z.infer<typeof ArborTreeSchema>;
