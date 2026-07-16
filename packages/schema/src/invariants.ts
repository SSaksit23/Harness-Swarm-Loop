import type { ArborTree } from "./tree.js";

export interface Violation {
  rule: 1 | 2 | 3 | 4;
  title: string;
  message: string;
}

const RULE_TITLES: Record<Violation["rule"], string> = {
  1: "A standard exists",
  2: "Something can say no",
  3: "Every loop halts",
  4: "Every run teaches",
};

function violation(rule: Violation["rule"], message: string): Violation {
  return { rule, title: RULE_TITLES[rule], message };
}

/**
 * The four control rules from the spec. The engine refuses to start a run
 * when any of these is violated; the workbench validates them on save.
 */
export function validateInvariants(tree: ArborTree): Violation[] {
  const out: Violation[] = [];

  // 1. A standard exists: the goal compiles to >=1 checkable criterion.
  if (!tree.labels.goal.trim()) {
    out.push(violation(1, "goal label is empty — no run starts against a vibe"));
  }
  const briefCriteria = tree.nodes
    .filter((n) => n.type === "brief")
    .flatMap((n) => (Array.isArray(n.config.success_criteria) ? n.config.success_criteria : []));
  const hasMetric = tree.labels.metric_scope.metric.trim().length > 0;
  if (!hasMetric && briefCriteria.length === 0) {
    out.push(
      violation(1, "no checkable success criteria — set metric_scope.metric or brief.success_criteria"),
    );
  }

  // 2. Something can say no: every execution node reaches a verifier.
  const verifierIds = new Set(tree.nodes.filter((n) => n.type === "verifier").map((n) => n.id));
  if (verifierIds.size === 0) {
    out.push(violation(2, "tree has no verifier node — claims would be evidence of nothing"));
  } else {
    const adjacency = new Map<string, string[]>();
    for (const e of tree.edges) {
      const list = adjacency.get(e.from) ?? [];
      list.push(e.to);
      adjacency.set(e.from, list);
    }
    const reachesVerifier = (start: string): boolean => {
      const seen = new Set<string>([start]);
      const queue = [start];
      while (queue.length) {
        const id = queue.shift()!;
        if (verifierIds.has(id)) return true;
        for (const next of adjacency.get(id) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return false;
    };
    for (const node of tree.nodes) {
      if ((node.type === "worker" || node.type === "orchestrator") && !reachesVerifier(node.id)) {
        out.push(
          violation(2, `execution node "${node.id}" has no path to a verifier — its output ships unchecked`),
        );
      }
    }
  }

  // 3. Every loop halts: all three hard stops finite and positive.
  const b = tree.labels.budget;
  const finite = (v: number) => Number.isFinite(v) && v > 0;
  if (!finite(b.max_iterations) || !Number.isInteger(b.max_iterations)) {
    out.push(violation(3, `budget.max_iterations must be a finite positive integer (got ${b.max_iterations})`));
  }
  if (!finite(b.cost_ceiling_usd)) {
    out.push(violation(3, `budget.cost_ceiling_usd must be finite and positive (got ${b.cost_ceiling_usd})`));
  }
  if (!finite(b.no_progress_window) || !Number.isInteger(b.no_progress_window)) {
    out.push(violation(3, `budget.no_progress_window must be a finite positive integer (got ${b.no_progress_window})`));
  }

  // 4. Every run teaches: a memory node with an incoming crystallize edge.
  const memoryIds = new Set(tree.nodes.filter((n) => n.type === "memory").map((n) => n.id));
  if (memoryIds.size === 0) {
    out.push(violation(4, "tree has no memory node — every run would start cold"));
  } else if (!tree.edges.some((e) => e.kind === "mem" && memoryIds.has(e.to))) {
    out.push(violation(4, "no crystallize (kind: mem) edge into a memory node — failures repeat instead of teaching"));
  }

  return out;
}
