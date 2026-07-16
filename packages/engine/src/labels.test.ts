import { describe, expect, it } from "vitest";
import { validateInvariants, defaultTree } from "@arbor/schema";
import { compileLabels } from "./labels.js";

describe("label compiler (fixture mode)", () => {
  it("extracts a budget ceiling from the mission text", async () => {
    const { labels, report } = await compileLabels("keep my tests green overnight, stop at $5", { fixture: true });
    expect(labels.budget.cost_ceiling_usd).toBe(5);
    expect(labels.trigger).toBe("cron");
    const budgetRow = report.find((r) => r.field === "budget")!;
    expect(budgetRow.needsConfirm).toBe(false);
    expect(budgetRow.source).toContain("$5");
  });

  it("flags low-confidence labels for confirmation", async () => {
    const { flagged, report } = await compileLabels("fix my project", { fixture: true });
    expect(flagged).toBe(true);
    expect(report.find((r) => r.field === "metric_scope")!.needsConfirm).toBe(true);
  });

  it("compiled labels always yield a tree that satisfies the invariants", async () => {
    const { labels } = await compileLabels("make the suite pass", { fixture: true });
    expect(validateInvariants(defaultTree(labels))).toEqual([]);
  });
});
