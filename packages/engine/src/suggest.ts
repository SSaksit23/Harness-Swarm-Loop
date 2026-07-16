import type { ArborTree } from "@arbor/schema";
import { MODEL_TIERS } from "./agents.js";

export interface SuggestResult {
  text: string;
}

function treeContext(tree: ArborTree, targetId: string): string {
  const lines: string[] = [
    `## Mission labels`,
    `goal: ${tree.labels.goal}`,
    `metric: ${tree.labels.metric_scope.metric} (${tree.labels.metric_scope.threshold})`,
    `budget: ${tree.labels.budget.max_iterations} iterations / $${tree.labels.budget.cost_ceiling_usd} / no-progress ${tree.labels.budget.no_progress_window}`,
    ...(tree.labels.context.length ? [`context: ${tree.labels.context.join("; ")}`] : []),
    ...(tree.labels.out_of_scope.length ? [`out of scope: ${tree.labels.out_of_scope.join("; ")}`] : []),
    ``,
    `## Every node in the tree (all layers — harness, swarm, loop)`,
  ];
  for (const n of tree.nodes) {
    const cfg = JSON.stringify(n.config);
    lines.push(`- ${n.id} [${n.type}, ${n.layer} layer] "${n.label}"${cfg !== "{}" ? ` config=${cfg.slice(0, 300)}` : ""}${n.id === targetId ? "   <-- TARGET" : ""}`);
  }
  lines.push(``, `## Edges (typed handoffs)`);
  for (const e of tree.edges) lines.push(`- ${e.from} -> ${e.to} (${e.kind})`);
  return lines.join("\n");
}

function connectedIds(tree: ArborTree, targetId: string): string[] {
  const ids = new Set<string>();
  for (const e of tree.edges) {
    if (e.from === targetId) ids.add(e.to);
    if (e.to === targetId) ids.add(e.from);
  }
  return [...ids];
}

/** Deterministic draft for tests and offline demos — still cross-node aware. */
function fixtureSuggest(tree: ArborTree, targetId: string): SuggestResult {
  const node = tree.nodes.find((n) => n.id === targetId)!;
  const neighbours = connectedIds(tree, targetId);
  return {
    text:
      `Purpose: "${node.label}" (${node.type}, ${node.layer} layer) serves the mission "${tree.labels.goal}". ` +
      `It exchanges data with ${neighbours.length ? neighbours.join(", ") : "no other nodes yet"}. ` +
      `Suggested next step: describe what this node receives, what it must emit, and which success criterion (${tree.labels.metric_scope.metric}) it helps satisfy.`,
  };
}

/**
 * The node writer: when the user runs out of ideas, one premium-model pass
 * drafts content for a node by reading the WHOLE tree — labels, every node
 * across the harness/swarm/loop layers, and the edges — so the draft is
 * grounded in what the surrounding nodes already say.
 */
export async function suggestNodeText(
  tree: ArborTree,
  nodeId: string,
  opts: { fixture?: boolean } = {},
): Promise<SuggestResult> {
  const node = tree.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error(`no node with id "${nodeId}"`);
  if (opts.fixture) return fixtureSuggest(tree, nodeId);

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("no Anthropic credentials — set ANTHROPIC_API_KEY to use the node writer");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const prompt = [
    `You are the node writer of ARBOR, a tree-based workbench for controlled autonomous dev systems (Harness = the standard, Swarm = the workers, Loop = the clock and the stop).`,
    ``,
    `The user is drafting the node marked TARGET below and ran out of ideas. Write its content for them:`,
    `1. Purpose — one or two sentences, grounded in the mission and the node's layer.`,
    `2. What it receives and emits — derived from its edges and neighbouring nodes (pull relevant details from OTHER nodes, across all three layers).`,
    `3. Suggested config — 2-4 concrete key/value suggestions consistent with sibling nodes' configs.`,
    ``,
    `Keep it under 150 words, plain prose + a short config list. No preamble.`,
    ``,
    treeContext(tree, nodeId),
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL_TIERS.premium,
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content.find((b) => b.type === "text")?.text?.trim();
  if (!text) throw new Error("node writer returned no text");
  return { text };
}
