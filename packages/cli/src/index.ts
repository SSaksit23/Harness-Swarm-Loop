import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import pc from "picocolors";
import { criteriaFromLabels, defaultTree, validateInvariants } from "@arbor/schema";
import { FileStore, openMemoryStore } from "@arbor/store";
import {
  EventBus,
  InvariantError,
  LlmPlanner,
  MODEL_TIERS,
  ScriptedAgent,
  SdkAgent,
  compileLabels,
  curate,
  runChecks,
  runLoop,
  type ArborEvent,
  type SwarmOptions,
} from "@arbor/engine";

const STAGE_NAMES: Record<number, string> = {
  1: "T1 load",
  2: "T2 plan",
  3: "T3 execute",
  4: "T4 verify",
  5: "T5 decide",
  6: "T6 crystallize",
};

function renderEvent(e: ArborEvent): void {
  switch (e.type) {
    case "stage":
      console.log(pc.dim(`── ${STAGE_NAMES[e.n] ?? e.label} ──`));
      break;
    case "status": {
      const color = e.state === "pass" ? pc.green : e.state === "fail" ? pc.red : e.state === "running" ? pc.yellow : pc.dim;
      console.log(`${pc.bold(e.agent.padEnd(14))} ${color(e.state)}${e.task ? pc.dim(`  ${e.task.slice(0, 80)}`) : ""}`);
      break;
    }
    case "thought":
      console.log(pc.dim(`  [${e.owner}] `) + e.text.split("\n")[0].slice(0, 160));
      break;
    case "spend": {
      const pct = Math.min(100, (e.usd_total / e.ceiling_usd) * 100);
      const warn = pct > 80 ? pc.red : pc.cyan;
      console.log(warn(`  spend $${e.usd_total.toFixed(2)} / $${e.ceiling_usd.toFixed(2)} ceiling (${pct.toFixed(0)}%) · ${e.tokens_total.toLocaleString()} tokens`));
      break;
    }
    case "decision":
      console.log(pc.bold(`  loop decision: ${e.decision} `) + pc.dim(`(iteration ${e.iteration}/${e.max_iterations} — ${e.reason})`));
      break;
    case "checkin":
      console.log(
        pc.yellow(
          pc.bold(
            `⏸ check-in — iteration ${e.report.iteration}/${e.report.max_iterations} · spend $${e.report.spend_usd.toFixed(2)}/$${e.report.ceiling_usd.toFixed(2)} · verifier ${e.report.last_verdict}${e.report.failing.length ? ` (failing: ${e.report.failing.join(", ")})` : ""}`,
          ),
        ),
      );
      console.log(pc.dim(`  next: ${e.report.next}`));
      break;
    case "checkin_result":
      console.log(pc.dim(`  operator answered: ${e.action}${e.note ? ` — ${e.note}` : ""}`));
      break;
    case "run_end":
      console.log("");
      console.log(pc.bold(e.outcome === "pass" ? pc.green(`✔ run complete: ${e.outcome}`) : pc.red(`■ run halted: ${e.outcome}`)));
      console.log(`  ticks: ${e.ticks} · spend: $${e.spend_usd.toFixed(2)}${e.branch ? ` · results on branch ${pc.cyan(e.branch)}` : ""}`);
      break;
    default:
      break;
  }
}

async function stores(dir: string) {
  const files = new FileStore(path.resolve(dir));
  files.init(); // idempotent — the DB lives inside arbor/, which must exist first
  const memory = await openMemoryStore(files, path.basename(path.resolve(dir)));
  return { files, memory };
}

const program = new Command()
  .name("arbor")
  .description("Tree-based Harness–Swarm–Loop workbench: plant a mission, run a controlled loop.")
  .option("-C, --dir <path>", "target project directory", ".");

program
  .command("init")
  .description("scaffold the arbor/ control directory inside the target project")
  .action(() => {
    const dir = path.resolve(program.opts().dir);
    const files = new FileStore(dir);
    files.init();
    console.log(pc.green(`initialized ${files.root}`));
    console.log(pc.dim(`next: arbor plant "<describe the mission>"`));
  });

program
  .command("plant")
  .argument("<mission...>", "plain-language mission description")
  .description("compile mission text into labels (LLM), confirm, and write the HSL tree")
  .option("--fixture", "use the offline fixture compiler instead of the API", false)
  .option("-y, --yes", "accept flagged labels without prompting", false)
  .action(async (missionWords: string[], opts: { fixture: boolean; yes: boolean }) => {
    const dir = path.resolve(program.opts().dir);
    const { files, memory } = await stores(dir);
    const mission = missionWords.join(" ");

    console.log(pc.dim(`compiling labels from: "${mission}"`));
    const { labels, report, flagged } = await compileLabels(mission, { fixture: opts.fixture });

    console.log("");
    for (const row of report) {
      const conf = row.needsConfirm ? pc.red(`${(row.confidence * 100).toFixed(0)}% ⚑`) : pc.green(`${(row.confidence * 100).toFixed(0)}%`);
      console.log(`${pc.bold(row.field.padEnd(14))} ${conf}  ${JSON.stringify(row.value)}${row.source ? pc.dim(`  ← "${row.source.slice(0, 50)}"`) : pc.dim("  (defaulted)")}`);
    }

    if (flagged && !opts.yes) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(pc.yellow("\nflagged labels above were guessed — accept and plant? [y/N] "))).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log(pc.red("not planted — re-run plant with a more specific mission, or edit arbor/tree/tree.json"));
        process.exitCode = 1;
        await memory.close();
        return;
      }
    }

    const tree = defaultTree(labels);
    const violations = validateInvariants(tree);
    if (violations.length) {
      console.error(pc.red("compiled tree violates control invariants:"));
      for (const v of violations) console.error(pc.red(`  [rule ${v.rule}] ${v.message}`));
      process.exitCode = 1;
      await memory.close();
      return;
    }
    files.writeTree(tree);
    await memory.close();
    console.log(pc.green(`\nplanted ${path.join(files.treeDir, "tree.json")}`));
    console.log(pc.dim("next: arbor run"));
  });

program
  .command("run")
  .description("run the loop: load context → execute → verify → decide → crystallize")
  .option("--mock", "use a no-op scripted agent (exercises the hard stops, no API calls)", false)
  .option("--model <id>", "model for the sequential agent / orchestrator", MODEL_TIERS.premium)
  .option("--swarm", "enable the swarm layer: orchestrator plans, workers fan out on the cheap tier", false)
  .option("--workers <n>", "max parallel workers in swarm mode", "3")
  .option("--no-sandbox", "run in place instead of a git worktree")
  .action(async (opts: { mock: boolean; model: string; swarm: boolean; workers: string; sandbox: boolean }) => {
    const dir = path.resolve(program.opts().dir);
    const { files, memory } = await stores(dir);
    const tree = files.readTree();

    const events = new EventBus();
    events.on(renderEvent);

    if (opts.mock && opts.swarm) {
      console.error(pc.red("--mock and --swarm cannot be combined (the mock agent exists to exercise the hard stops)"));
      process.exitCode = 1;
      await memory.close();
      return;
    }

    const executor = opts.mock ? new ScriptedAgent([], 0.25) : new SdkAgent(opts.model);
    const swarm: SwarmOptions | undefined = opts.swarm
      ? {
          planner: new LlmPlanner(opts.model),
          makeWorker: () => new SdkAgent(MODEL_TIERS.cheap),
          maxParallel: Math.max(1, Number(opts.workers) || 3),
        }
      : undefined;

    console.log(pc.bold(`goal: ${tree.labels.goal}`));
    console.log(
      pc.dim(
        `agent: ${executor.name}${opts.mock ? " (mock)" : ` (${opts.model})`}${swarm ? ` · swarm: ${opts.model} plans, ${MODEL_TIERS.cheap} executes (≤${swarm.maxParallel} parallel)` : ""} · budget: ${tree.labels.budget.max_iterations} iters / $${tree.labels.budget.cost_ceiling_usd} / no-progress ${tree.labels.budget.no_progress_window}\n`,
      ),
    );

    // Human-gate answers come from this terminal when it's interactive; a
    // non-TTY run leaves the channel unset (the engine skips check-ins).
    const humanGate = process.stdin.isTTY
      ? {
          ask: async () => {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            try {
              const answer = (await rl.question(pc.yellow("  continue [c] / revise [r] / stop [s]? "))).trim().toLowerCase();
              if (answer === "s" || answer === "stop") return { action: "stop" as const };
              if (answer === "r" || answer === "revise") {
                const note = await rl.question("  guidance for the agent: ");
                return { action: "revise" as const, note };
              }
              return { action: "continue" as const };
            } finally {
              rl.close();
            }
          },
        }
      : undefined;

    try {
      await runLoop({ projectDir: dir, tree, files, memory, executor, events, sandbox: opts.sandbox, swarm, humanGate });
    } catch (err) {
      if (err instanceof InvariantError) {
        console.error(pc.red(err.message));
        process.exitCode = 1;
      } else {
        throw err;
      }
    } finally {
      await memory.close();
    }
  });

program
  .command("watch")
  .description("cron-style trigger: re-check the metric on an interval and run the loop only when it fails")
  .option("--every <minutes>", "minutes between checks", "30")
  .option("--mock", "use the no-op scripted agent", false)
  .option("--model <id>", "model for the real agent", MODEL_TIERS.premium)
  .action(async (opts: { every: string; mock: boolean; model: string }) => {
    const dir = path.resolve(program.opts().dir);
    const { files, memory } = await stores(dir);
    const intervalMs = Math.max(1, Number(opts.every) || 30) * 60_000;
    console.log(pc.bold(`watching ${path.basename(dir)}`) + pc.dim(` — verifier check every ${opts.every} min; loop engages only on failure (Ctrl+C to stop)`));
    try {
      for (;;) {
        const tree = files.readTree();
        const check = await runChecks(criteriaFromLabels(tree.labels), dir);
        if (check.verdict === "pass") {
          console.log(pc.green(`${new Date().toLocaleTimeString()} all green — sleeping ${opts.every} min`));
        } else {
          console.log(pc.yellow(`${new Date().toLocaleTimeString()} verifier failing — engaging the loop`));
          const events = new EventBus();
          events.on(renderEvent);
          const executor = opts.mock ? new ScriptedAgent([], 0.25) : new SdkAgent(opts.model);
          await runLoop({ projectDir: dir, tree, files, memory, executor, events });
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } finally {
      await memory.close();
    }
  });

program
  .command("curate")
  .description("compounding pass: promote heavily-recalled lessons to skills, surface (or prune) dead memory")
  .option("--min-usage <n>", "recalls needed before a lesson becomes a skill", "3")
  .option("--prune", "delete never-recalled entries older than --stale-days", false)
  .option("--stale-days <n>", "age threshold for pruning", "14")
  .action(async (opts: { minUsage: string; prune: boolean; staleDays: string }) => {
    const dir = path.resolve(program.opts().dir);
    const { files, memory } = await stores(dir);
    try {
      const report = await curate(files, memory, {
        minUsageForSkill: Math.max(1, Number(opts.minUsage) || 3),
        prune: opts.prune,
        pruneAfterDays: Math.max(0, Number(opts.staleDays) || 14),
      });
      console.log(pc.bold("curation report"));
      console.log(`  memory entries: ${report.memory_entries} · skills: ${report.skills_total}`);
      if (report.promoted.length) console.log(pc.green(`  promoted to skills: ${report.promoted.join(", ")}`));
      if (report.pruned.length) console.log(pc.red(`  pruned: ${report.pruned.join(", ")}`));
      if (report.stale.length) console.log(pc.yellow(`  stale (never recalled — re-run with --prune to delete): ${report.stale.join(", ")}`));
      if (!report.promoted.length && !report.stale.length && !report.pruned.length) console.log(pc.dim("  nothing to do — the library is clean"));
    } finally {
      await memory.close();
    }
  });

program
  .command("status")
  .description("summarize the planted tree and the last run")
  .action(async () => {
    const dir = path.resolve(program.opts().dir);
    const { files, memory } = await stores(dir);
    if (!files.hasTree()) {
      console.log(pc.dim("no tree planted — run `arbor plant` first"));
      await memory.close();
      return;
    }
    const tree = files.readTree();
    console.log(pc.bold(`goal: `) + tree.labels.goal);
    console.log(pc.bold(`budget: `) + `${tree.labels.budget.max_iterations} iterations / $${tree.labels.budget.cost_ceiling_usd} / no-progress window ${tree.labels.budget.no_progress_window}`);
    const ticks = files.readTicks();
    if (!ticks.length) {
      console.log(pc.dim("no runs yet"));
    } else {
      const last = ticks.at(-1)!;
      console.log(pc.bold(`last tick: `) + `#${last.tick} — verifier ${last.verifier.verdict}, decision ${last.loop_decision}, total spend $${last.spend_total_usd.toFixed(2)}`);
    }
    console.log(pc.bold(`memory entries: `) + String(await memory.count()));
    console.log(pc.bold(`skills: `) + String(files.listSkills().length));
    await memory.close();
  });

const skillsCmd = program.command("skills").description("inspect promoted skills");
skillsCmd
  .command("ls")
  .description("list skills")
  .action(() => {
    const dir = path.resolve(program.opts().dir);
    const files = new FileStore(dir);
    const entries = files.listSkills();
    if (!entries.length) {
      console.log(pc.dim("no skills yet — run `arbor curate` after a few runs to promote repeated lessons"));
      return;
    }
    for (const e of entries) console.log(`${pc.bold(e.name)} ${pc.dim(`[${e.tags.join(", ")}]`)}`);
  });
skillsCmd
  .command("show <name>")
  .description("print one skill")
  .action((name: string) => {
    const dir = path.resolve(program.opts().dir);
    const files = new FileStore(dir);
    const entry = files.listSkills().find((e) => e.name === name);
    if (!entry) {
      console.error(pc.red(`no skill named "${name}"`));
      process.exitCode = 1;
      return;
    }
    console.log(pc.bold(entry.name) + pc.dim(` (${entry.created_at})`));
    console.log(entry.text);
  });

program
  .command("serve")
  .description("start the workbench backend: HTTP API + websocket event feed")
  .option("-p, --port <n>", "port to listen on", "4177")
  .action(async (opts: { port: string }) => {
    const dir = path.resolve(program.opts().dir);
    const { createArborServer } = await import("./server.js");
    const arbor = createArborServer(dir);
    const port = Math.max(1, Number(opts.port) || 4177);
    arbor.server.listen(port, () => {
      console.log(pc.green(`arbor serve — project ${pc.bold(path.basename(dir))}`));
      console.log(`  api  ${pc.cyan(`http://localhost:${port}/api/status`)}`);
      console.log(`  ws   ${pc.cyan(`ws://localhost:${port}/ws`)}`);
      console.log(pc.dim(`  workbench dev UI: npm run dev -w apps/workbench (proxies to this port)`));
    });
  });

const memoryCmd = program.command("memory").description("inspect crystallized project memory");
memoryCmd
  .command("ls")
  .description("list memory entries")
  .action(() => {
    const dir = path.resolve(program.opts().dir);
    const files = new FileStore(dir);
    const entries = files.listMemoryEntries();
    if (!entries.length) {
      console.log(pc.dim("no memory yet — memory crystallizes at the end of every tick"));
      return;
    }
    for (const e of entries) {
      console.log(`${pc.bold(e.name)} ${pc.dim(`[${e.tags.join(", ")}] tick ${e.source_tick ?? "-"}`)}`);
    }
  });
memoryCmd
  .command("show <name>")
  .description("print one memory entry")
  .action((name: string) => {
    const dir = path.resolve(program.opts().dir);
    const files = new FileStore(dir);
    const entry = files.listMemoryEntries().find((e) => e.name === name);
    if (!entry) {
      console.error(pc.red(`no memory entry named "${name}"`));
      process.exitCode = 1;
      return;
    }
    console.log(pc.bold(entry.name) + pc.dim(` (${entry.created_at})`));
    console.log(entry.text);
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
