import fs from "node:fs";
import path from "node:path";
import {
  PlanSchema,
  SwarmTaskResultSchema,
  type MissionLabels,
  type Plan,
  type SuccessCriterion,
  type SwarmTaskResult,
  type TaskSpec,
} from "@arbor/schema";
import type { AgentExecutor } from "./agents.js";
import { MODEL_TIERS } from "./agents.js";
import type { EventBus } from "./events.js";
import { commitAll, git, type Sandbox } from "./sandbox.js";

/* ------------------------------------------------------------------ */
/* Planner (the orchestrator's brain: ceiling test + task split)      */
/* ------------------------------------------------------------------ */

export interface PlanInput {
  goal: string;
  criteria: SuccessCriterion[];
  context: string[];
  outOfScope: string[];
  recalled: string[];
  lastFailureSummary: string | null;
  widthHint: MissionLabels["width_hint"];
}

export interface PlannerOutput {
  /** Raw, unvalidated plan — the swarm validates it against PlanSchema. */
  raw: unknown;
  costUsd: number;
  tokens: number;
}

export interface Planner {
  readonly name: string;
  plan(input: PlanInput, previousViolation?: string): Promise<PlannerOutput>;
}

/** Deterministic planner for tests and offline runs. */
export class ScriptedPlanner implements Planner {
  readonly name = "scripted-planner";
  calls = 0;

  constructor(
    private readonly outputs: unknown[],
    private readonly costPerPlanUsd = 0.1,
  ) {}

  async plan(): Promise<PlannerOutput> {
    const raw = this.outputs[Math.min(this.calls, this.outputs.length - 1)];
    this.calls += 1;
    return { raw, costUsd: this.costPerPlanUsd, tokens: 500 };
  }
}

const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    wide: { type: "boolean" },
    reason: { type: "string" },
    tasks: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          spec: { type: "string" },
          acceptance: { type: "string" },
          files_hint: { type: "array", items: { type: "string" } },
        },
        required: ["task_id", "spec", "acceptance", "files_hint"],
        additionalProperties: false,
      },
    },
  },
  required: ["wide", "reason", "tasks"],
  additionalProperties: false,
} as const;

// claude-opus-4-8 pricing ($/token) for planner spend accounting.
const OPUS_INPUT_USD = 5 / 1_000_000;
const OPUS_OUTPUT_USD = 25 / 1_000_000;

/**
 * The real orchestrator: one premium-model pass running the ceiling test.
 * Split only when the work is genuinely wide AND parallelizable into tasks
 * touching disjoint files — otherwise stay sequential.
 */
export class LlmPlanner implements Planner {
  readonly name = "orchestrator";

  constructor(private readonly model: string = MODEL_TIERS.premium) {}

  async plan(input: PlanInput, previousViolation?: string): Promise<PlannerOutput> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("no Anthropic credentials — set ANTHROPIC_API_KEY or run without --swarm");
    }
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();

    const parts = [
      `You are the orchestrator of a controlled autonomous dev swarm. Run the ceiling test and, only if it passes, split the work.`,
      ``,
      `## Ceiling test`,
      `Set wide=true ONLY if the work is genuinely wide: 2-8 independent subtasks that touch DISJOINT files and can run in parallel without coordinating. Small or sequential work -> wide=false with empty tasks (a single agent will handle it). When in doubt, wide=false.`,
      input.widthHint === "wide" ? `The user forced width_hint=wide: produce 2-8 disjoint tasks.` : ``,
      ``,
      `## Goal`,
      input.goal,
      ``,
      `## Success criteria (verifier commands)`,
      ...input.criteria.map((c) => `- ${c.check}`),
      ...(input.context.length ? [``, `## Context`, ...input.context.map((c) => `- ${c}`)] : []),
      ...(input.outOfScope.length ? [``, `## Out of scope`, ...input.outOfScope.map((c) => `- ${c}`)] : []),
      ...(input.recalled.length ? [``, `## Lessons from memory`, ...input.recalled.map((r) => `- ${r}`)] : []),
      ...(input.lastFailureSummary ? [``, `## Previous attempt failed`, input.lastFailureSummary] : []),
      ...(previousViolation
        ? [``, `## Your previous plan was rejected (schema violation)`, previousViolation, `Produce a valid plan this time.`]
        : []),
      ``,
      `Each task needs: task_id (short slug), spec (what to do, self-contained), acceptance (how the worker knows it's done), files_hint (files it will touch — MUST be disjoint across tasks).`,
    ].filter((line) => line !== undefined);

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: PLAN_JSON_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{ role: "user", content: parts.join("\n") }],
    } as Parameters<typeof client.messages.create>[0]);

    const message = response as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = message.content.find((b) => b.type === "text")?.text ?? "{}";
    const inTok = message.usage?.input_tokens ?? 0;
    const outTok = message.usage?.output_tokens ?? 0;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = { invalid: text };
    }
    return { raw, costUsd: inTok * OPUS_INPUT_USD + outTok * OPUS_OUTPUT_USD, tokens: inTok + outTok };
  }
}

export interface ValidatedPlan {
  plan: Plan;
  costUsd: number;
  tokens: number;
  requeued: boolean;
}

/**
 * Edge-contract enforcement on the orchestrator -> worker handoff: an invalid
 * plan is rejected and requeued once; a second violation degrades the tick to
 * sequential mode instead of shipping malformed tasks to workers.
 */
export async function planWithContract(planner: Planner, input: PlanInput, events: EventBus): Promise<ValidatedPlan> {
  let costUsd = 0;
  let tokens = 0;
  let requeued = false;

  const first = await planner.plan(input);
  costUsd += first.costUsd;
  tokens += first.tokens;
  let parsed = PlanSchema.safeParse(first.raw);

  if (!parsed.success) {
    requeued = true;
    const violation = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    events.emit({
      type: "thought",
      owner: planner.name,
      layer: "swarm",
      text: `plan rejected (schema violation: ${violation.slice(0, 120)}) — requeueing`,
    });
    const second = await planner.plan(input, violation);
    costUsd += second.costUsd;
    tokens += second.tokens;
    parsed = PlanSchema.safeParse(second.raw);
  }

  if (!parsed.success) {
    events.emit({
      type: "thought",
      owner: planner.name,
      layer: "swarm",
      text: "plan rejected twice — degrading tick to sequential mode",
    });
    return { plan: { wide: false, reason: "plan schema violation (twice)", tasks: [] }, costUsd, tokens, requeued };
  }

  // duplicate task ids violate the contract too
  const plan = parsed.data;
  const ids = new Set(plan.tasks.map((t) => t.task_id));
  if (ids.size !== plan.tasks.length) {
    return { plan: { wide: false, reason: "duplicate task ids in plan", tasks: [] }, costUsd, tokens, requeued: true };
  }
  return { plan, costUsd, tokens, requeued };
}

/* ------------------------------------------------------------------ */
/* Wide execution: parallel workers in task worktrees + merge-back     */
/* ------------------------------------------------------------------ */

export interface WideExecutionOptions {
  projectDir: string;
  sandbox: Sandbox;
  tasks: TaskSpec[];
  makeWorker: (task: TaskSpec, index: number) => AgentExecutor;
  buildTaskPrompt: (task: TaskSpec) => string;
  events: EventBus;
  maxParallel?: number;
}

export interface WideExecutionResult {
  taskResults: SwarmTaskResult[];
  costUsd: number;
  tokens: number;
  summary: string;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

function taskBranchName(runBranch: string, task: TaskSpec): string {
  const slug = task.task_id.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40);
  return `${runBranch}-t-${slug}`;
}

/**
 * Fan out: each task gets its own git worktree branched from the run branch,
 * a worker (cheap tier) executes inside it, and results merge back into the
 * run branch sequentially. A merge conflict marks the task failed (requeued
 * by the next tick's re-plan) instead of corrupting the run. Outside git the
 * fan-out degrades to sequential execution in the shared sandbox.
 */
export async function executeWide(opts: WideExecutionOptions): Promise<WideExecutionResult> {
  const { sandbox, tasks, events } = opts;
  const taskResults: SwarmTaskResult[] = [];
  let costUsd = 0;
  let tokens = 0;

  const runWorker = async (task: TaskSpec, index: number, cwd: string): Promise<SwarmTaskResult> => {
    const workerName = `worker-${index + 1}`;
    events.emit({ type: "status", agent: workerName, state: "running", task: `${task.task_id}: ${task.spec.slice(0, 60)}` });
    try {
      const worker = opts.makeWorker(task, index);
      const result = await worker.execute({
        prompt: opts.buildTaskPrompt(task),
        cwd,
        onThought: (text) => events.emit({ type: "thought", owner: workerName, layer: "swarm", text }),
      });
      events.emit({ type: "status", agent: workerName, state: "pass", task: task.task_id });
      return SwarmTaskResultSchema.parse({
        task_id: task.task_id,
        ok: true,
        summary: result.summary,
        usd: result.costUsd,
        tokens: result.tokens,
        error: null,
      });
    } catch (err) {
      events.emit({ type: "status", agent: workerName, state: "fail", task: task.task_id });
      return SwarmTaskResultSchema.parse({
        task_id: task.task_id,
        ok: false,
        summary: "",
        usd: 0,
        tokens: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (sandbox.kind !== "worktree" || !sandbox.branch) {
    // No git isolation available: run tasks sequentially in the shared dir.
    events.emit({
      type: "thought",
      owner: "orchestrator",
      layer: "swarm",
      text: `no git sandbox — running ${tasks.length} tasks sequentially in place`,
    });
    for (const [index, task] of tasks.entries()) {
      const result = await runWorker(task, index, sandbox.dir);
      taskResults.push(result);
      costUsd += result.usd;
      tokens += result.tokens;
    }
  } else {
    // Commit the current run state so task branches include prior ticks.
    await commitAll(sandbox.dir, "arbor: tick base before fan-out");
    const head = await git(["rev-parse", "HEAD"], sandbox.dir);
    const baseRef = head.stdout.trim();

    // Git admin ops (worktree add/remove, merge) run sequentially — only the
    // workers themselves run in parallel — to avoid racing repo lock files.
    const lanes: Array<{ task: TaskSpec; branch: string; dir: string; setupError: string | null }> = [];
    for (const [index, task] of tasks.entries()) {
      const branch = taskBranchName(sandbox.branch, task);
      const dir = `${sandbox.dir}-t${index + 1}`;
      const add = await git(["worktree", "add", "-b", branch, dir, baseRef], opts.projectDir);
      lanes.push({
        task,
        branch,
        dir,
        setupError: add.exitCode === 0 ? null : `failed to create task worktree: ${add.stderr.slice(0, 200)}`,
      });
    }

    const executed = await mapPool(lanes, opts.maxParallel ?? 3, async (lane, index) => {
      if (lane.setupError) {
        return SwarmTaskResultSchema.parse({
          task_id: lane.task.task_id,
          ok: false,
          summary: "",
          usd: 0,
          tokens: 0,
          error: lane.setupError,
        });
      }
      return runWorker(lane.task, index, lane.dir);
    });

    // Commit each lane, merge back, clean up — sequential; a conflict fails
    // that task (requeued via the next tick's re-plan), not the run.
    for (const [index, lane] of lanes.entries()) {
      const result = executed[index];
      if (result.ok) {
        await commitAll(lane.dir, `arbor task ${lane.task.task_id}`);
      }
      await git(["worktree", "remove", "--force", lane.dir], opts.projectDir);
      fs.rmSync(lane.dir, { recursive: true, force: true });
      if (result.ok) {
        const merge = await git(["merge", "--no-ff", "--no-edit", lane.branch], sandbox.dir);
        if (merge.exitCode !== 0) {
          await git(["merge", "--abort"], sandbox.dir);
          result.ok = false;
          result.error = "merge conflict with earlier task (overlapping edits) — requeue next tick";
          events.emit({
            type: "thought",
            owner: "verifier",
            layer: "gate",
            text: `task ${lane.task.task_id} rejected: ${result.error}`,
          });
        }
      }
      await git(["branch", "-D", lane.branch], opts.projectDir);
      taskResults.push(result);
      costUsd += result.usd;
      tokens += result.tokens;
    }
  }

  const summary = taskResults
    .map((r) => `${r.task_id}: ${r.ok ? r.summary || "done" : `FAILED (${r.error})`}`)
    .join(" | ");
  return { taskResults, costUsd, tokens, summary };
}

/** Prompt for one worker: self-contained task, shared guardrails. */
export function buildWorkerPrompt(task: TaskSpec, labels: MissionLabels): string {
  const parts = [
    `You are a worker agent in a swarm, executing ONE task inside a sandboxed checkout. Other workers handle other tasks in parallel — stay strictly within your task.`,
    ``,
    `## Your task (${task.task_id})`,
    task.spec,
    ...(task.acceptance ? [``, `## Done when`, task.acceptance] : []),
    ...(task.files_hint.length ? [``, `## Files you are expected to touch (stay within them)`, ...task.files_hint.map((f) => `- ${f}`)] : []),
    ``,
    `## Overall mission (context only — do NOT do the other tasks)`,
    labels.goal,
    ...(labels.out_of_scope.length ? [``, `## Out of scope — do NOT touch`, ...labels.out_of_scope.map((c) => `- ${c}`)] : []),
    ``,
    `Work directly in the current directory. Finish with a one-sentence summary of what you changed.`,
  ];
  return parts.join("\n");
}
