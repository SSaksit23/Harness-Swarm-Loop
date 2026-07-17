# ARBOR

Tree-based Harness–Swarm–Loop (HSL) workbench for engineering **controlled** autonomous dev systems.
One root (the mission and its input labels), three branches: the **Harness** (the standard),
the **Swarm** (the workers), the **Loop** (the clock and the stop).

The full design spec lives in [docs/design.html](docs/design.html).

## Layout

- `packages/schema` — zod schemas (mission labels, tree, contracts, tick records) + the four control-invariant validators
- `packages/store` — file store (`arbor/` dir inside a target repo, git-versionable source of truth) + SQLite memory index with hybrid recall
- `packages/engine` — the loop runner (hard stops enforced outside the model), agent executors (Claude Agent SDK + scripted mock), command verifier, label compiler, event bus
- `packages/cli` — `arbor init | plant | run | status | memory`
- `examples/demo-repo` — tiny repo with a deliberately failing test, used by the e2e suite

## Quick start

```sh
npm install
npm test                      # unit + e2e (offline, mock agent)

# Real run against a repo (needs ANTHROPIC_API_KEY — .env is auto-loaded):
npm run arbor -- init   -C path/to/repo
npm run arbor -- plant  -C path/to/repo 'make the test suite green, stop at $5'
# ^ use SINGLE quotes in PowerShell/bash — double quotes make the shell expand `$5`
npm run arbor -- run    -C path/to/repo            # add --swarm for orchestrator + parallel workers
npm run arbor -- watch  -C path/to/repo --every 30 # cron-style: re-check the metric, loop only on failure

# Compounding:
npm run arbor -- curate -C path/to/repo            # promote lessons recalled 3+ times into skills
npm run arbor -- skills ls -C path/to/repo

# Workbench UI:
npm run arbor -- serve  -C path/to/repo            # API + built UI on http://localhost:4177
npm run dev -w apps/workbench                      # hot-reloading dev UI on http://localhost:5177
```

Memory tier: SQLite by default (`arbor/index.db`, zero setup). Set `ARBOR_MONGODB_URI`
(and optionally `ARBOR_MONGODB_DB`) to move the memory index to MongoDB — the files
under `arbor/` remain the source of truth either way.

## Model tiers — the control architecture

Model choice is **tree configuration, not code**. The default tree seeds a
three-role control architecture; edit any node's `config.model` from the
canvas, or override everything with `arbor run --model <id>`:

| role | where | default |
| --- | --- | --- |
| 🧠 plan / decide / control / review | `orchestrator` node `config.model` | `claude-opus-4-8` |
| ⚡ implement the hard parts | `worker` node `config.model` | `claude-fable-5` |
| 🔍 E2E review (reserved) | `verifier` node `config.review_model` | `claude-sonnet-5` |

The planner, label compiler, and node writer run on the **plan** model; the
sequential agent and every swarm worker run on the **execute** model. The
verifier itself stays command-based (exit codes, not opinions) — its
`review_model` is reserved for future LLM-assisted verification.

> Built with [Claude Code](https://claude.com/claude-code) — every feature ran
> a research → design → implement → verify-in-the-browser → fix cycle, gated by
> `tsc` + the offline test suite + the production build before landing.

## Control invariants

The engine refuses to start a run unless all four hold:

1. **A standard exists** — the goal compiles to at least one checkable success criterion.
2. **Something can say no** — every execution path passes through a verifier node.
3. **Every loop halts** — max iterations, no-progress window, and cost ceiling are all finite, enforced in the runner outside any model call.
4. **Every run teaches** — a memory node with a crystallize edge is present; each tick writes a record and a lesson.
