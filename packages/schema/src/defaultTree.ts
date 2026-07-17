import type { ArborTree, TreeEdge, TreeNode } from "./tree.js";
import type { MissionLabels } from "./labels.js";
import { criteriaFromLabels } from "./labels.js";

/**
 * The canonical HSL tree: one Mission Root, three branches, verifier gate,
 * crystallize back-edge. This is what `arbor plant` writes to disk.
 */
export function defaultTree(labels: MissionLabels): ArborTree {
  const nodes: TreeNode[] = [
    { id: "root", type: "mission", layer: "root", label: "MISSION", parent: null, config: {} },

    { id: "harness", type: "harness", layer: "harness", label: "HARNESS", parent: "root", config: {} },
    {
      id: "brief",
      type: "brief",
      layer: "harness",
      label: "brief",
      parent: "harness",
      config: { success_criteria: criteriaFromLabels(labels) },
    },
    { id: "memory", type: "memory", layer: "harness", label: "memory", parent: "harness", config: { recall_k: 5 } },
    { id: "skills", type: "skills", layer: "harness", label: "skills", parent: "harness", config: {} },

    { id: "swarm", type: "swarm", layer: "swarm", label: "SWARM", parent: "root", config: { width_hint: labels.width_hint } },
    // Model tiers follow the control architecture: the strongest controller
    // plans and reviews, the implementation model writes the hard parts, and
    // a review model is reserved for LLM-assisted verification. All editable
    // per node (config.model) from the canvas.
    {
      id: "orchestrator",
      type: "orchestrator",
      layer: "swarm",
      label: "orchestrator",
      parent: "swarm",
      config: { model: "claude-opus-4-8", role: "plans, decides, controls, reviews" },
    },
    {
      id: "worker",
      type: "worker",
      layer: "swarm",
      label: "worker",
      parent: "swarm",
      config: { model: "claude-fable-5", role: "implements the hard parts (code, algorithms)" },
    },
    {
      id: "verifier",
      type: "verifier",
      layer: "swarm",
      label: "verifier",
      parent: "swarm",
      config: { on_fail: "requeue", review_model: "claude-sonnet-5", role: "command checks gate; review_model reserved for LLM-assisted E2E review" },
    },

    { id: "loop", type: "loop", layer: "loop", label: "LOOP", parent: "root", config: {} },
    {
      id: "contract",
      type: "contract",
      layer: "loop",
      label: "contract",
      parent: "loop",
      config: { trigger: labels.trigger, scope: "one mission per run" },
    },
    {
      id: "hard_stops",
      type: "hard_stops",
      layer: "loop",
      label: "hard stops",
      parent: "loop",
      config: { ...labels.budget, enforced_by: "engine" },
    },
  ];

  const edges: TreeEdge[] = [
    { from: "root", to: "harness", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "root", to: "swarm", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "root", to: "loop", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "harness", to: "brief", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "harness", to: "memory", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "harness", to: "skills", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "swarm", to: "orchestrator", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "orchestrator", to: "worker", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "worker", to: "verifier", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "loop", to: "contract", kind: "data", on_schema_violation: "reject_and_requeue" },
    { from: "loop", to: "hard_stops", kind: "data", on_schema_violation: "reject_and_requeue" },
    // The thing that says no, wired back into the loop's decision:
    { from: "verifier", to: "loop", kind: "gate", on_schema_violation: "fail_tick" },
    // Crystallize: lessons flow back into memory (invariant 4):
    { from: "verifier", to: "memory", kind: "mem", on_schema_violation: "reject_and_requeue" },
  ];

  return { version: 1, labels, nodes, edges };
}
