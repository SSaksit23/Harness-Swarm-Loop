import { describe, expect, it } from "vitest";
import {
  ArborTreeSchema,
  BudgetSchema,
  MissionLabelsSchema,
  defaultTree,
  validateInvariants,
  type MissionLabels,
} from "./index.js";

function labels(overrides: Partial<MissionLabels> = {}): MissionLabels {
  return MissionLabelsSchema.parse({
    goal: "make the test suite green",
    metric_scope: { metric: "node --test" },
    ...overrides,
  });
}

describe("schemas", () => {
  it("applies finite budget defaults (never unlimited)", () => {
    const b = BudgetSchema.parse({});
    expect(b.max_iterations).toBe(8);
    expect(b.cost_ceiling_usd).toBe(10);
    expect(b.no_progress_window).toBe(2);
  });

  it("rejects non-finite budgets at parse time", () => {
    expect(() => BudgetSchema.parse({ cost_ceiling_usd: Infinity })).toThrow();
    expect(() => BudgetSchema.parse({ max_iterations: 0 })).toThrow();
  });

  it("round-trips the default tree through the schema", () => {
    const tree = defaultTree(labels());
    const parsed = ArborTreeSchema.parse(JSON.parse(JSON.stringify(tree)));
    expect(parsed.nodes.length).toBe(tree.nodes.length);
    expect(parsed.labels.goal).toBe("make the test suite green");
  });
});

describe("control invariants", () => {
  it("the canonical tree passes all four", () => {
    expect(validateInvariants(defaultTree(labels()))).toEqual([]);
  });

  it("rule 1: empty goal / missing criteria are rejected", () => {
    const tree = defaultTree(labels());
    tree.labels = { ...tree.labels, goal: "  ", metric_scope: { ...tree.labels.metric_scope, metric: " " } };
    for (const n of tree.nodes) if (n.type === "brief") n.config = {};
    const rules = validateInvariants(tree).map((v) => v.rule);
    expect(rules).toContain(1);
  });

  it("rule 2: removing the verifier is rejected", () => {
    const tree = defaultTree(labels());
    tree.nodes = tree.nodes.filter((n) => n.type !== "verifier");
    tree.edges = tree.edges.filter((e) => e.from !== "verifier" && e.to !== "verifier");
    // keep invariant 4 satisfied so we isolate rule 2
    tree.edges.push({ from: "harness", to: "memory", kind: "mem", on_schema_violation: "reject_and_requeue" });
    const rules = validateInvariants(tree).map((v) => v.rule);
    expect(rules).toContain(2);
    expect(rules).not.toContain(4);
  });

  it("rule 2: a worker disconnected from the verifier is rejected", () => {
    const tree = defaultTree(labels());
    tree.edges = tree.edges.filter((e) => !(e.from === "worker" && e.to === "verifier"));
    const rules = validateInvariants(tree).map((v) => v.rule);
    expect(rules).toContain(2);
  });

  it("rule 3: a tampered non-finite budget is rejected", () => {
    const tree = defaultTree(labels());
    tree.labels.budget.cost_ceiling_usd = Number.POSITIVE_INFINITY;
    const rules = validateInvariants(tree).map((v) => v.rule);
    expect(rules).toContain(3);
  });

  it("rule 4: removing the crystallize edge is rejected", () => {
    const tree = defaultTree(labels());
    tree.edges = tree.edges.filter((e) => e.kind !== "mem");
    const rules = validateInvariants(tree).map((v) => v.rule);
    expect(rules).toContain(4);
  });
});
