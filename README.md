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

# Real run against a repo (needs ANTHROPIC_API_KEY):
npm run arbor -- init   -C path/to/repo
npm run arbor -- plant  -C path/to/repo "make the test suite green, stop at $5"
npm run arbor -- run    -C path/to/repo
```

## Control invariants

The engine refuses to start a run unless all four hold:

1. **A standard exists** — the goal compiles to at least one checkable success criterion.
2. **Something can say no** — every execution path passes through a verifier node.
3. **Every loop halts** — max iterations, no-progress window, and cost ceiling are all finite, enforced in the runner outside any model call.
4. **Every run teaches** — a memory node with a crystallize edge is present; each tick writes a record and a lesson.
