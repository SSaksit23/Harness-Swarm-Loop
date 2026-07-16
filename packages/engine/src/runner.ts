import crypto from "node:crypto";
import {
  criteriaFromLabels,
  validateInvariants,
  type ArborTree,
  type LoopDecision,
  type SuccessCriterion,
  type SwarmTaskResult,
  type TaskSpec,
  type TickRecord,
} from "@arbor/schema";
import type { FileStore, MemoryStore } from "@arbor/store";
import type { AgentExecutor } from "./agents.js";
import { EventBus, type CheckinAction, type CheckinReport, type HumanGate } from "./events.js";
import { runChecks, type VerifierResult } from "./verifier.js";
import { createSandbox } from "./sandbox.js";
import { buildWorkerPrompt, executeWide, planWithContract, type Planner } from "./swarm.js";

export type RunOutcome = "pass" | "max_iterations" | "no_progress" | "cost_ceiling" | "human_stop";

export interface SwarmOptions {
  planner: Planner;
  makeWorker: (task: TaskSpec, index: number) => AgentExecutor;
  maxParallel?: number;
}

export interface RunOptions {
  projectDir: string;
  tree: ArborTree;
  files: FileStore;
  memory: MemoryStore;
  executor: AgentExecutor;
  events?: EventBus;
  /** Disable the git-worktree sandbox and run in place (tests use temp dirs). */
  sandbox?: boolean;
  /** Enable the swarm layer: orchestrator plans, workers fan out. Absent = single-agent. */
  swarm?: SwarmOptions;
  /** Operator channel for human_gate check-ins (CLI readline, workbench button, ...). */
  humanGate?: HumanGate;
}

export interface RunResult {
  outcome: RunOutcome;
  ticks: number;
  spendUsd: number;
  branch: string | null;
}

export class InvariantError extends Error {
  constructor(readonly violations: ReturnType<typeof validateInvariants>) {
    super(
      "refusing to run — control invariants violated:\n" +
        violations.map((v) => `  [rule ${v.rule}: ${v.title}] ${v.message}`).join("\n"),
    );
  }
}

function criteriaFor(tree: ArborTree): SuccessCriterion[] {
  const brief = tree.nodes.find((n) => n.type === "brief");
  const fromBrief = Array.isArray(brief?.config.success_criteria)
    ? (brief!.config.success_criteria as SuccessCriterion[])
    : [];
  return fromBrief.length ? fromBrief : criteriaFromLabels(tree.labels);
}

function buildPrompt(tree: ArborTree, recalled: string[], lastFailure: VerifierResult | null, guidance: string[] = []): string {
  const { labels } = tree;
  const parts: string[] = [
    `You are an autonomous engineering agent working inside a sandboxed checkout of a repository.`,
    ``,
    `## Goal`,
    labels.goal,
    ``,
    `## Success criteria (a separate verifier will run these commands; only exit code 0 passes)`,
    ...criteriaFor(tree).map((c) => `- \`${c.check}\``),
  ];
  if (labels.context.length) {
    parts.push(``, `## Context`, ...labels.context.map((c) => `- ${c}`));
  }
  if (labels.out_of_scope.length) {
    parts.push(``, `## Out of scope — do NOT touch`, ...labels.out_of_scope.map((c) => `- ${c}`));
  }
  if (recalled.length) {
    parts.push(``, `## Lessons from previous runs (project memory)`, ...recalled.map((r) => `- ${r}`));
  }
  if (guidance.length) {
    parts.push(``, `## Guidance from the operator (given mid-run — follow it)`, ...guidance.map((g) => `- ${g}`));
  }
  if (lastFailure) {
    parts.push(
      ``,
      `## Previous attempt failed verification`,
      ...lastFailure.checks
        .filter((c) => !c.ok)
        .map((c) => `Check \`${c.criterion}\` failed (exit ${c.exit_code}). Output:\n${c.output}`),
      ``,
      `Diagnose the root cause and fix it — do not repeat the same approach.`,
    );
  }
  parts.push(
    ``,
    `Work directly in the current directory. Make the changes, run the checks yourself, and finish with a one-paragraph summary of what you changed and why.`,
  );
  return parts.join("\n");
}

/**
 * Test runners embed wall-clock noise (durations, timestamps) in their output;
 * strip it so "the same failure" hashes identically across ticks and the
 * no-progress detector actually detects.
 */
function normalizeOutput(output: string): string {
  return output
    .replace(/duration_ms[^\n]*/gi, "duration_ms:#")
    .replace(/\b\d+(\.\d+)?\s*m?s\b/g, "#")
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.]+Z?\b/g, "#ts#");
}

function failureHash(result: VerifierResult): string {
  const canonical = result.checks
    .filter((c) => !c.ok)
    .map((c) => `${c.criterion}:${c.exit_code}:${normalizeOutput(c.output)}`)
    .join("|");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * The loop that halts. One tick = load context -> execute -> verify -> decide
 * -> crystallize. All three hard stops (max iterations, no-progress window,
 * cost ceiling) are enforced HERE, outside any model call — a model cannot
 * talk its way past them.
 */
export async function runLoop(opts: RunOptions): Promise<RunResult> {
  const events = opts.events ?? new EventBus();
  const { tree, files, memory, executor } = opts;

  const violations = validateInvariants(tree);
  if (violations.length) throw new InvariantError(violations);

  const budget = tree.labels.budget;
  const criteria = criteriaFor(tree);
  const runId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const sandbox =
    opts.sandbox === false
      ? { dir: opts.projectDir, kind: "in-place" as const, branch: null, finalize: async () => null }
      : await createSandbox(opts.projectDir, runId);

  let spendUsd = 0;
  let spendTokens = 0;
  let lastFailure: VerifierResult | null = null;
  let lastFailHash: string | null = null;
  let repeatedFailures = 0;
  let outcome: RunOutcome = "max_iterations";
  let ticksRun = 0;
  /** Mid-run operator guidance from human_gate revisions, fed into every later prompt/plan. */
  const guidance: string[] = [];

  const gateNode = tree.nodes.find((n) => n.type === "human_gate");
  const gate =
    gateNode && opts.humanGate
      ? {
          intervalMs: Math.max(0, Number(gateNode.config.interval_minutes ?? 10)) * 60_000,
          timeoutMs: Math.max(50, Number(gateNode.config.timeout_minutes ?? 60) * 60_000),
          onTimeout: gateNode.config.on_timeout === "stop" ? ("stop" as const) : ("continue" as const),
        }
      : null;
  if (gateNode && !opts.humanGate) {
    events.emit({
      type: "thought",
      owner: "loop",
      layer: "loop",
      text: "human gate present but no operator channel connected — check-ins skipped",
    });
  }
  let lastCheckin = Date.now();

  for (let iteration = 1; iteration <= budget.max_iterations; iteration++) {
    const startedAt = new Date().toISOString();
    ticksRun = iteration;

    // T1 — harness loads context
    events.emit({ type: "stage", n: 1, label: "load context" });
    const recalledHits = memory.recall(tree.labels.goal, 5);
    const recalled = recalledHits.map((h) => `${h.name}: ${h.text}`);
    events.emit({
      type: "thought",
      owner: "harness",
      layer: "harness",
      text: `brief loaded; ${recalledHits.length} memory entr${recalledHits.length === 1 ? "y" : "ies"} recalled`,
    });

    // T2 — plan: ceiling test decides wide (swarm fan-out) vs sequential.
    let mode: TickRecord["mode"] = "sequential";
    let taskResults: SwarmTaskResult[] = [];
    let tasks: TaskSpec[] = [];
    if (opts.swarm && tree.labels.width_hint !== "narrow") {
      events.emit({ type: "stage", n: 2, label: "plan" });
      events.emit({ type: "status", agent: opts.swarm.planner.name, state: "running", task: "ceiling test + plan" });
      const validated = await planWithContract(
        opts.swarm.planner,
        {
          goal: tree.labels.goal,
          criteria,
          context: [...tree.labels.context, ...guidance],
          outOfScope: tree.labels.out_of_scope,
          recalled,
          lastFailureSummary: lastFailure
            ? lastFailure.checks
                .filter((c) => !c.ok)
                .map((c) => `${c.criterion} failed: ${c.output.slice(0, 400)}`)
                .join("\n")
            : null,
          widthHint: tree.labels.width_hint,
        },
        events,
      );
      spendUsd += validated.costUsd;
      spendTokens += validated.tokens;
      events.emit({ type: "status", agent: opts.swarm.planner.name, state: "idle" });
      if (validated.plan.wide && validated.plan.tasks.length > 0) {
        mode = "wide";
        tasks = validated.plan.tasks;
        events.emit({
          type: "thought",
          owner: opts.swarm.planner.name,
          layer: "swarm",
          text: `wide: ${tasks.length} tasks — ${tasks.map((t) => t.task_id).join(", ")}${validated.plan.reason ? ` (${validated.plan.reason.slice(0, 80)})` : ""}`,
        });
      } else {
        events.emit({
          type: "thought",
          owner: opts.swarm.planner.name,
          layer: "swarm",
          text: `sequential${validated.plan.reason ? `: ${validated.plan.reason.slice(0, 100)}` : ""}`,
        });
      }
    }

    // T3 — execute: fan out to workers (wide) or run the single agent.
    events.emit({ type: "stage", n: 3, label: "execute" });
    let agentResult: { summary: string; costUsd: number; tokens: number };
    if (mode === "wide" && opts.swarm) {
      const wide = await executeWide({
        projectDir: opts.projectDir,
        sandbox,
        tasks,
        makeWorker: opts.swarm.makeWorker,
        buildTaskPrompt: (task) => buildWorkerPrompt(task, tree.labels),
        events,
        maxParallel: opts.swarm.maxParallel,
      });
      taskResults = wide.taskResults;
      agentResult = { summary: wide.summary, costUsd: wide.costUsd, tokens: wide.tokens };
    } else {
      events.emit({ type: "status", agent: executor.name, state: "running", task: tree.labels.goal });
      const prompt = buildPrompt(tree, recalled, lastFailure, guidance);
      agentResult = await executor.execute({
        prompt,
        cwd: sandbox.dir,
        onThought: (text) => events.emit({ type: "thought", owner: executor.name, layer: "swarm", text }),
      });
      events.emit({ type: "status", agent: executor.name, state: "idle" });
    }
    spendUsd += agentResult.costUsd;
    spendTokens += agentResult.tokens;
    events.emit({ type: "spend", usd_total: spendUsd, tokens_total: spendTokens, ceiling_usd: budget.cost_ceiling_usd });

    // T4 — verify (claims are evidence of nothing)
    events.emit({ type: "stage", n: 4, label: "verify" });
    events.emit({ type: "status", agent: "verifier", state: "running", task: criteria.map((c) => c.check).join(" && ") });
    const verifierResult = await runChecks(criteria, sandbox.dir);
    events.emit({ type: "status", agent: "verifier", state: verifierResult.verdict === "pass" ? "pass" : "fail" });
    events.emit({
      type: "thought",
      owner: "verifier",
      layer: "gate",
      text:
        verifierResult.verdict === "pass"
          ? "all checks green"
          : `rejected: ${verifierResult.checks.filter((c) => !c.ok).map((c) => c.criterion).join(", ")} failed`,
    });

    // T5 — decide (hard stops enforced here, in order of precedence)
    events.emit({ type: "stage", n: 5, label: "decide" });
    let decision: LoopDecision;
    let reason: string;
    if (verifierResult.verdict === "pass") {
      decision = "stop_pass";
      reason = "verifier pass";
      outcome = "pass";
    } else {
      const hash = failureHash(verifierResult);
      repeatedFailures = hash === lastFailHash ? repeatedFailures + 1 : 1;
      lastFailHash = hash;
      lastFailure = verifierResult;

      if (spendUsd >= budget.cost_ceiling_usd) {
        decision = "stop_cost_ceiling";
        reason = `spend $${spendUsd.toFixed(2)} reached ceiling $${budget.cost_ceiling_usd.toFixed(2)}`;
        outcome = "cost_ceiling";
      } else if (repeatedFailures >= budget.no_progress_window) {
        decision = "stop_no_progress";
        reason = `identical failure ${repeatedFailures} times (window ${budget.no_progress_window})`;
        outcome = "no_progress";
      } else if (iteration >= budget.max_iterations) {
        decision = "stop_max_iterations";
        reason = `iteration cap ${budget.max_iterations} reached`;
        outcome = "max_iterations";
      } else {
        decision = "continue";
        reason = "verifier failed, budget remains";
      }
    }

    // Human gate: on the configured interval, pause before continuing —
    // report status + next step and wait for continue / revise / stop.
    if (decision === "continue" && gate && Date.now() - lastCheckin >= gate.intervalMs) {
      const report: CheckinReport = {
        iteration,
        max_iterations: budget.max_iterations,
        spend_usd: spendUsd,
        ceiling_usd: budget.cost_ceiling_usd,
        last_verdict: verifierResult.verdict,
        failing: verifierResult.checks.filter((c) => !c.ok).map((c) => c.criterion),
        next: `re-plan from the failure output and retry (iteration ${iteration + 1}/${budget.max_iterations})`,
        interval_minutes: gate.intervalMs / 60_000,
      };
      events.emit({ type: "checkin", report });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const answer = await Promise.race([
        opts.humanGate!.ask(report),
        new Promise<CheckinAction>((resolve) => {
          timer = setTimeout(() => resolve({ action: gate.onTimeout, note: "check-in timed out" }), gate.timeoutMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (timer) clearTimeout(timer);
      events.emit({ type: "checkin_result", action: answer.action, note: answer.note ?? null });
      lastCheckin = Date.now();
      if (answer.action === "stop") {
        decision = "stop_human";
        reason = "operator stopped the run at check-in";
        outcome = "human_stop";
      } else if (answer.action === "revise" && answer.note?.trim()) {
        guidance.push(answer.note.trim());
        events.emit({ type: "thought", owner: "loop", layer: "loop", text: `operator guidance: ${answer.note.trim().slice(0, 140)}` });
      }
    }

    events.emit({ type: "decision", decision, iteration, max_iterations: budget.max_iterations, reason });

    // T6 — crystallize (a tick is not complete until it teaches)
    events.emit({ type: "stage", n: 6, label: "crystallize" });
    const tickNumber = files.nextTickNumber();
    const lessonName = `run-${runId}-tick-${tickNumber}`;
    const lessonText =
      verifierResult.verdict === "pass"
        ? `Goal "${tree.labels.goal}" achieved. Approach: ${agentResult.summary || "(no summary)"}`
        : `Goal "${tree.labels.goal}" attempt failed. Failing checks: ${verifierResult.checks
            .filter((c) => !c.ok)
            .map((c) => `${c.criterion} -> ${c.output.slice(0, 300)}`)
            .join("; ")}. Agent tried: ${agentResult.summary || "(no summary)"}`;
    const entry = files.writeMemoryEntry({
      name: lessonName,
      text: lessonText,
      tags: [verifierResult.verdict, "auto"],
      source_tick: tickNumber,
    });
    memory.crystallize({ name: entry.name, text: entry.text, tags: entry.tags, source_tick: tickNumber });

    const record: TickRecord = {
      tick: tickNumber,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      mode,
      swarm_tasks: taskResults,
      agent_summary: agentResult.summary,
      verifier: verifierResult,
      loop_decision: decision,
      spend_delta: { tokens: agentResult.tokens, usd: agentResult.costUsd },
      spend_total_usd: spendUsd,
      crystallized: [entry.name],
    };
    files.writeTick(record);
    events.emit({ type: "tick", record });

    if (decision !== "continue") break;
  }

  const branch = await sandbox.finalize(`arbor: ${tree.labels.goal} (${outcome}, ${ticksRun} ticks)`);
  events.emit({ type: "run_end", outcome, ticks: ticksRun, spend_usd: spendUsd, branch });
  return { outcome, ticks: ticksRun, spendUsd, branch };
}
