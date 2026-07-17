import { describe, expect, it } from "vitest";
import { MissionLabelsSchema, defaultTree } from "@arbor/schema";
import { MODEL_TIERS, resolveModels } from "./agents.js";

const tree = () =>
  defaultTree(MissionLabelsSchema.parse({ goal: "g", metric_scope: { metric: "node --test" } }));

describe("model tiers from tree config", () => {
  it("the default tree seeds the control architecture (opus plans, fable implements)", () => {
    const models = resolveModels(tree());
    expect(models.plan).toBe("claude-opus-4-8");
    expect(models.execute).toBe("claude-fable-5");
    // reserved review model documented on the verifier node
    const verifier = tree().nodes.find((n) => n.type === "verifier")!;
    expect(verifier.config.review_model).toBe("claude-sonnet-5");
  });

  it("node config edits change the resolved models", () => {
    const t = tree();
    t.nodes.find((n) => n.type === "worker")!.config.model = "claude-haiku-4-5";
    t.nodes.find((n) => n.type === "orchestrator")!.config.model = "claude-sonnet-5";
    const models = resolveModels(t);
    expect(models).toEqual({ plan: "claude-sonnet-5", execute: "claude-haiku-4-5" });
  });

  it("an explicit override beats the tree; missing nodes fall back to the premium tier", () => {
    expect(resolveModels(tree(), "claude-opus-4-8")).toEqual({ plan: "claude-opus-4-8", execute: "claude-opus-4-8" });
    const bare = { nodes: [] as Array<{ type: string; config: Record<string, unknown> }> };
    expect(resolveModels(bare)).toEqual({ plan: MODEL_TIERS.premium, execute: MODEL_TIERS.premium });
  });
});
