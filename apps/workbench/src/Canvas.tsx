import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArborTree, Layer, NodeType, TreeEdge, TreeNode, Violation } from "@arbor/schema";
import { api } from "./api.js";

const VB = { w: 760, h: 560 };
const H = 44;

const LAYER_COLOR: Record<string, string> = {
  root: "var(--root-node)",
  harness: "var(--harness)",
  swarm: "var(--swarm)",
  loop: "var(--loop)",
};
const NODE_TYPES: NodeType[] = [
  "mission", "harness", "brief", "memory", "skills", "swarm", "orchestrator",
  "worker", "verifier", "loop", "contract", "hard_stops", "sandbox", "human_gate", "custom",
];

/** What to write in each node — shown in the inspector so nobody stares at an empty box. */
const TYPE_HINTS: Record<NodeType, { hint: string; example: string }> = {
  mission: {
    hint: "The root. Its labels (goal, metric, budget) come from `arbor plant` — edit them there, not here.",
    example: `{ "pos": { "x": 30, "y": 280 } }`,
  },
  harness: {
    hint: "The standard: what the agent knows and must obey. Use config for run-wide rules.",
    example: `{ "rules": ["never touch payments/", "prefer small diffs"] }`,
  },
  brief: {
    hint: "Success criteria the verifier runs — each check is a shell command; exit 0 = pass.",
    example: `{ "success_criteria": [{ "id": "tests", "check": "npm test", "pass_when": "exit 0" }] }`,
  },
  memory: {
    hint: "Recall settings: how many lessons from past runs get injected each tick.",
    example: `{ "recall_k": 5 }`,
  },
  skills: {
    hint: "Reusable procedures promoted from repeated work. List skill names to mount.",
    example: `{ "mount": ["fix-flaky-tests"] }`,
  },
  swarm: {
    hint: "The workers. width_hint: auto lets the orchestrator run the ceiling test; narrow forces one agent.",
    example: `{ "width_hint": "auto" }`,
  },
  orchestrator: {
    hint: "Plans and splits (premium model). Config can steer how it decomposes work.",
    example: `{ "model_tier": "premium", "max_tasks": 4 }`,
  },
  worker: {
    hint: "Executes one task inside the sandbox (cheap model). Claims are never trusted — only verified.",
    example: `{ "model_tier": "cheap" }`,
  },
  verifier: {
    hint: "The thing that says no. on_fail: requeue retries next tick; fail_tick ends the tick.",
    example: `{ "on_fail": "requeue" }`,
  },
  loop: {
    hint: "The clock and the stop. Children: contract, hard stops, and optionally a human gate.",
    example: `{}`,
  },
  contract: {
    hint: "When a run triggers and how much one tick may attempt.",
    example: `{ "trigger": "manual", "scope": "one mission per run" }`,
  },
  hard_stops: {
    hint: "The three finite caps, enforced by the engine outside the model. Edit budgets via plant.",
    example: `{ "max_iterations": 8, "cost_ceiling_usd": 10, "no_progress_window": 2 }`,
  },
  sandbox: {
    hint: "Isolation for the run — a git worktree branch by default; the main checkout is never touched.",
    example: `{ "fs": "worktree" }`,
  },
  human_gate: {
    hint: "Human-in-the-loop: the loop pauses every interval_minutes, reports status + next step, and waits for continue / revise / stop. on_timeout decides what happens if nobody answers.",
    example: `{ "interval_minutes": 10, "timeout_minutes": 60, "on_timeout": "continue" }`,
  },
  custom: {
    hint: "Your node. Use config.notes for prose; add any keys your workflow needs — or let the AI draft it.",
    example: `{ "notes": "receives task specs from the orchestrator, emits …" }`,
  },
};

type Pos = { x: number; y: number };
type Selection = { kind: "node"; id: string } | { kind: "edge"; index: number } | null;

function nodeWidth(node: TreeNode): number {
  return Math.max(96, Math.min(190, node.label.length * 7.4 + 36));
}

function posOf(node: TreeNode): Pos | null {
  const p = node.config?.pos as Pos | undefined;
  return p && typeof p.x === "number" && typeof p.y === "number" ? p : null;
}

/** Column layout for nodes without a saved position: root → branches → leaves → deeper. */
function autoLayout(tree: ArborTree): Map<string, Pos> {
  const out = new Map<string, Pos>();
  const depthOf = (n: TreeNode): number => {
    let depth = 0;
    let cur: TreeNode | undefined = n;
    while (cur?.parent && depth < 3) {
      cur = tree.nodes.find((p) => p.id === cur!.parent);
      depth++;
    }
    return Math.min(depth, 3);
  };
  const cols: TreeNode[][] = [[], [], [], []];
  for (const n of tree.nodes) {
    if (!posOf(n)) cols[depthOf(n)].push(n);
  }
  const colX = [30, 235, 455, 620];
  cols.forEach((list, col) => {
    if (!list.length) return;
    const gap = Math.max(H + 14, Math.min(80, (VB.h - 90) / list.length));
    const totalHeight = (list.length - 1) * gap;
    const yStart = col === 0 ? VB.h / 2 - totalHeight / 2 : Math.max(50, (VB.h - totalHeight) / 2 - 40);
    list.forEach((n, i) => out.set(n.id, { x: colX[col], y: Math.max(H / 2 + 6, yStart + i * gap) }));
  });
  return out;
}

/**
 * Never let two nodes overlap: rects that intersect get pushed apart
 * vertically (wrapping into a fresh spot when the column runs out of room).
 */
function resolveCollisions(positions: Map<string, Pos>, nodes: TreeNode[], skip?: string): Map<string, Pos> {
  const out = new Map(positions);
  const PAD = 8;
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const pa = out.get(a.id)!;
        const pb = out.get(b.id)!;
        const overlapX = pa.x < pb.x + nodeWidth(b) + PAD && pb.x < pa.x + nodeWidth(a) + PAD;
        const overlapY = Math.abs(pa.y - pb.y) < H + PAD;
        if (!overlapX || !overlapY) continue;
        // move whichever isn't being dragged / isn't first
        const victim = b.id === skip ? a : b;
        const anchor = victim === b ? pa : pb;
        const p = { ...out.get(victim.id)! };
        p.y = anchor.y + H + PAD + 2;
        if (p.y > VB.h - H / 2 - 6) {
          p.y = H / 2 + 10;
          p.x = Math.min(VB.w - nodeWidth(victim) - 6, p.x + 30);
        }
        out.set(victim.id, p);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}

function edgePath(a: { x: number; y: number; w: number }, b: { x: number; y: number; w: number }): string {
  const sRight = a.x + a.w;
  const tRight = b.x + b.w;
  if (b.x >= sRight - 10) {
    const d = Math.max(30, Math.min(80, Math.abs(b.x - sRight) / 2));
    return `M${sRight} ${a.y} C ${sRight + d} ${a.y}, ${b.x - d} ${b.y}, ${b.x} ${b.y}`;
  }
  if (a.x >= tRight - 10) {
    const d = Math.max(30, Math.min(80, Math.abs(a.x - tRight) / 2));
    return `M${a.x} ${a.y} C ${a.x - d} ${a.y}, ${tRight + d} ${b.y}, ${tRight} ${b.y}`;
  }
  const bow = 60;
  return `M${sRight} ${a.y} C ${sRight + bow} ${a.y}, ${tRight + bow} ${b.y}, ${tRight} ${b.y}`;
}

export function Canvas() {
  const [tree, setTree] = useState<ArborTree | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newLayer, setNewLayer] = useState<Layer>("harness");
  const [tempLine, setTempLine] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<
    | { kind: "move"; id: string; dx: number; dy: number; moved: boolean }
    | { kind: "connect"; from: string; x1: number; y1: number }
    | null
  >(null);
  const seq = useRef(0);
  // Undo/redo live outside React state (StrictMode double-invokes updaters,
  // so side effects in setTree callbacks would corrupt the stacks).
  const treeRef = useRef<ArborTree | null>(null);
  const undoStack = useRef<ArborTree[]>([]);
  const redoStack = useRef<ArborTree[]>([]);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  const load = useCallback(() => {
    api
      .tree()
      .then((t) => {
        undoStack.current = [];
        redoStack.current = [];
        treeRef.current = t;
        setTree(t);
        setError(null);
        setViolations([]);
        setDirty(false);
        setSelection({ kind: "node", id: t.nodes[0]?.id ?? "" });
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const positions = useMemo(() => {
    if (!tree) return new Map<string, Pos>();
    const auto = autoLayout(tree);
    const map = new Map<string, Pos>();
    for (const n of tree.nodes) map.set(n.id, posOf(n) ?? auto.get(n.id) ?? { x: 300, y: 300 });
    // keep the node being dragged where the pointer put it; nudge the others
    return resolveCollisions(map, tree.nodes, dragRef.current?.kind === "move" ? dragRef.current.id : undefined);
  }, [tree]);

  const mutate = useCallback((fn: (draft: ArborTree) => void, opts: { undoable?: boolean } = {}) => {
    const current = treeRef.current;
    if (!current) return;
    if (opts.undoable !== false) {
      undoStack.current.push(current);
      if (undoStack.current.length > 60) undoStack.current.shift();
      redoStack.current = [];
    }
    const next: ArborTree = JSON.parse(JSON.stringify(current));
    fn(next);
    treeRef.current = next;
    setTree(next);
    setDirty(true);
    setSavedNote(null);
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev || !treeRef.current) return;
    redoStack.current.push(treeRef.current);
    treeRef.current = prev;
    setTree(prev);
    setDirty(true);
    setSavedNote(null);
  }, []);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next || !treeRef.current) return;
    undoStack.current.push(treeRef.current);
    treeRef.current = next;
    setTree(next);
    setDirty(true);
    setSavedNote(null);
  }, []);

  const svgPoint = (e: { clientX: number; clientY: number }): Pos => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * VB.w,
      y: ((e.clientY - rect.top) / rect.height) * VB.h,
    };
  };

  const nodeAt = (p: Pos, exclude?: string): TreeNode | null => {
    if (!tree) return null;
    for (let i = tree.nodes.length - 1; i >= 0; i--) {
      const n = tree.nodes[i];
      if (n.id === exclude) continue;
      const pos = positions.get(n.id)!;
      const w = nodeWidth(n);
      if (p.x >= pos.x && p.x <= pos.x + w && p.y >= pos.y - H / 2 && p.y <= pos.y + H / 2) return n;
    }
    return null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !tree) return;
    const p = svgPoint(e);
    if (drag.kind === "move") {
      if (!drag.moved) {
        // one undo entry per drag, not per pointer-move frame
        undoStack.current.push(treeRef.current!);
        redoStack.current = [];
      }
      drag.moved = true;
      const node = tree.nodes.find((n) => n.id === drag.id)!;
      const w = nodeWidth(node);
      const x = Math.max(6, Math.min(VB.w - w - 6, p.x - drag.dx));
      const y = Math.max(H / 2 + 4, Math.min(VB.h - H / 2 - 4, p.y - drag.dy));
      mutate(
        (draft) => {
          const n = draft.nodes.find((m) => m.id === drag.id)!;
          n.config = { ...n.config, pos: { x: Math.round(x), y: Math.round(y) } };
        },
        { undoable: false },
      );
    } else {
      setTempLine({ x1: drag.x1, y1: drag.y1, x2: p.x, y2: p.y });
      setDropTarget(nodeAt(p, drag.from)?.id ?? null);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    dragRef.current = null;
    setTempLine(null);
    setDropTarget(null);
    if (!drag || !tree) return;
    if (drag.kind === "move") {
      if (!drag.moved) setSelection({ kind: "node", id: drag.id });
      return;
    }
    const target = nodeAt(svgPoint(e), drag.from);
    if (target && !tree.edges.some((ed) => ed.from === drag.from && ed.to === target.id)) {
      mutate((draft) => {
        draft.edges.push({ from: drag.from, to: target.id, kind: "data", on_schema_violation: "reject_and_requeue" });
      });
    }
  };

  const addNode = (parentId: string | null) => {
    if (!tree) return;
    const label = newLabel.trim() || `node ${++seq.current}`;
    const id = `u-${Date.now().toString(36)}-${seq.current++}`;
    const parent = parentId ? tree.nodes.find((n) => n.id === parentId) ?? null : null;
    const parentPos = parent ? positions.get(parent.id)! : null;
    const pos: Pos = parentPos
      ? { x: Math.min(VB.w - 130, parentPos.x + nodeWidth(parent!) + 56), y: Math.min(VB.h - 40, parentPos.y + 60) }
      : { x: 80 + ((tree.nodes.length * 53) % 480), y: 60 + ((tree.nodes.length * 83) % 440) };
    mutate((draft) => {
      draft.nodes.push({
        id,
        type: "custom",
        layer: parent && parent.layer !== "root" ? parent.layer : newLayer,
        label,
        parent: parentId,
        config: { pos },
      });
      if (parentId) draft.edges.push({ from: parentId, to: id, kind: "data", on_schema_violation: "reject_and_requeue" });
    });
    setNewLabel("");
    setSelection({ kind: "node", id });
  };

  const deleteSelected = useCallback(() => {
    if (!tree || !selection) return;
    if (selection.kind === "edge") {
      mutate((draft) => {
        draft.edges.splice(selection.index, 1);
      });
      setSelection(null);
    } else {
      const node = tree.nodes.find((n) => n.id === selection.id);
      if (!node || node.type === "mission") return; // the root stays
      mutate((draft) => {
        draft.nodes = draft.nodes.filter((n) => n.id !== selection.id);
        draft.edges = draft.edges.filter((e) => e.from !== selection.id && e.to !== selection.id);
        for (const n of draft.nodes) if (n.parent === selection.id) n.parent = null;
      });
      setSelection(null);
    }
  }, [tree, selection, mutate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const key = e.key.toLowerCase();
      if ((e.ctrlKey || e.metaKey) && key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, undo, redo]);

  const save = async () => {
    if (!tree) return;
    try {
      const res = await api.saveTree(tree);
      setViolations(res.violations);
      setDirty(false);
      setSavedNote(res.violations.length ? "saved (with advisories)" : "saved ✓");
    } catch (e) {
      setSavedNote(null);
      setError((e as Error).message);
    }
  };

  if (error && !tree) {
    return (
      <div className="empty">
        no tree planted — run <code>arbor plant</code> first ({error})
      </div>
    );
  }
  if (!tree) return <div className="empty">loading…</div>;

  const selectedNode = selection?.kind === "node" ? tree.nodes.find((n) => n.id === selection.id) ?? null : null;
  const selectedEdge = selection?.kind === "edge" ? tree.edges[selection.index] ?? null : null;

  return (
    <>
      <div className="toolbar">
        <input type="text" placeholder="new node label" value={newLabel} maxLength={24} onChange={(e) => setNewLabel(e.target.value)} />
        <select value={newLayer} onChange={(e) => setNewLayer(e.target.value as Layer)}>
          <option value="harness">harness</option>
          <option value="swarm">swarm</option>
          <option value="loop">loop</option>
        </select>
        <button className="btn" onClick={() => addNode(null)}>+ node</button>
        <button className="btn" onClick={() => addNode(selectedNode?.id ?? "root")}>+ sub-node</button>
        <button className="btn warn" onClick={deleteSelected}>delete selected</button>
        <button className="btn" onClick={undo} title="Ctrl+Z">↩ undo</button>
        <button className="btn" onClick={redo} title="Ctrl+Y / Ctrl+Shift+Z">↪ redo</button>
        <button
          className="btn"
          title="clear saved positions and re-run the collision-free layout"
          onClick={() =>
            mutate((draft) => {
              for (const n of draft.nodes) {
                const { pos: _pos, ...rest } = n.config as { pos?: unknown };
                n.config = rest;
              }
            })
          }
        >
          ⌗ arrange
        </button>
        <button className="btn" onClick={() => (window.location.href = "/api/export.zip")} title="download the tree as markdown files (one per node, sub-nodes in folders)">
          ⇩ export .zip
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={!dirty}>save tree</button>
        <button className="btn" onClick={load}>reload</button>
        {savedNote && <span className="savednote">{savedNote}</span>}
        {error && <span className="error">{error}</span>}
      </div>
      <div className="hint">click = inspect · drag node = move · drag ○ port → node = connect · delete key = remove · save validates the four invariants (advisory)</div>
      <div className="studio">
        <div className="canvasbox">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VB.w} ${VB.h}`}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerDown={(e) => {
              if (e.target === svgRef.current) setSelection(null);
            }}
          >
            {tree.edges.map((edge, i) => {
              const a = tree.nodes.find((n) => n.id === edge.from);
              const b = tree.nodes.find((n) => n.id === edge.to);
              if (!a || !b) return null;
              const pa = { ...positions.get(a.id)!, w: nodeWidth(a) };
              const pb = { ...positions.get(b.id)!, w: nodeWidth(b) };
              const d = edgePath(pa, pb);
              const cls = edge.kind === "gate" ? "edge-gate" : edge.kind === "mem" ? "edge-mem" : "edge";
              const sel = selection?.kind === "edge" && selection.index === i;
              return (
                <g key={`e-${i}`}>
                  <path className={`${cls}${sel ? " sel" : ""}`} d={d} />
                  <path
                    className="edge-hit"
                    d={d}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      setSelection({ kind: "edge", index: i });
                    }}
                  />
                </g>
              );
            })}
            {tempLine && <path className="temp" d={`M${tempLine.x1} ${tempLine.y1} L ${tempLine.x2} ${tempLine.y2}`} />}
            {tree.nodes.map((node) => {
              const pos = positions.get(node.id)!;
              const w = nodeWidth(node);
              const active = selection?.kind === "node" && selection.id === node.id;
              return (
                <g
                  key={node.id}
                  className={`node${active ? " active" : ""}${dropTarget === node.id ? " droptarget" : ""}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                    const p = svgPoint(e);
                    dragRef.current = { kind: "move", id: node.id, dx: p.x - pos.x, dy: p.y - pos.y, moved: false };
                  }}
                >
                  <rect className="body" x={pos.x} y={pos.y - H / 2} width={w} height={H} rx={4} />
                  <rect x={pos.x + 6} y={pos.y - H / 2 + 6} width={4} height={H - 12} rx={1.5} fill={node.type === "verifier" || node.type === "hard_stops" ? "var(--stop)" : LAYER_COLOR[node.layer]} />
                  <text className="nlabel" x={pos.x + 17} y={pos.y - 1}>{node.label}</text>
                  <text className="nsub" x={pos.x + 17} y={pos.y + 13}>{node.type}</text>
                  <circle
                    className="port"
                    cx={pos.x + w}
                    cy={pos.y}
                    r={5.5}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.target as Element).setPointerCapture?.(e.pointerId);
                      dragRef.current = { kind: "connect", from: node.id, x1: pos.x + w, y1: pos.y };
                    }}
                  />
                </g>
              );
            })}
          </svg>
        </div>

        <aside className="inspector">
          {selectedNode && (
            <NodeInspector
              node={selectedNode}
              edges={tree.edges}
              onChange={(patch) =>
                mutate((draft) => {
                  const n = draft.nodes.find((m) => m.id === selectedNode.id)!;
                  Object.assign(n, patch);
                })
              }
            />
          )}
          {selectedEdge && (
            <>
              <span className="tag" style={{ background: "var(--ink-faint)" }}>edge</span>
              <h3>
                {selectedEdge.from} → {selectedEdge.to}
              </h3>
              <div className="k">kind</div>
              <select
                value={selectedEdge.kind}
                onChange={(e) =>
                  mutate((draft) => {
                    draft.edges[(selection as { index: number }).index].kind = e.target.value as TreeEdge["kind"];
                  })
                }
              >
                <option value="data">data (typed handoff)</option>
                <option value="gate">gate (verifier verdict)</option>
                <option value="mem">mem (crystallize)</option>
              </select>
              <div className="k">on schema violation</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{selectedEdge.on_schema_violation}</div>
            </>
          )}
          {!selectedNode && !selectedEdge && <div className="empty">select a node or edge</div>}
          {violations.length > 0 && (
            <div className="violations">
              <div className="k">invariant advisories (engine refuses to run until fixed)</div>
              {violations.map((v, i) => (
                <div className="v" key={i}>
                  [rule {v.rule}] {v.message}
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function NodeInspector({
  node,
  edges,
  onChange,
}: {
  node: TreeNode;
  edges: TreeEdge[];
  onChange: (patch: Partial<TreeNode>) => void;
}) {
  const [configText, setConfigText] = useState(() => JSON.stringify(node.config, null, 2));
  const [configError, setConfigError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  useEffect(() => {
    setConfigText(JSON.stringify(node.config, null, 2));
    setConfigError(null);
    setDraft(null);
    setDraftError(null);
  }, [node.id, node.config]);

  const requestDraft = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const { text } = await api.suggest(node.id);
      setDraft(text);
    } catch (e) {
      setDraftError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };

  const inbound = edges.filter((e) => e.to === node.id);
  const outbound = edges.filter((e) => e.from === node.id);

  return (
    <>
      <span className="tag" style={{ background: LAYER_COLOR[node.layer] }}>{node.layer} layer</span>
      <h3>{node.label}</h3>
      <div className="k">id</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{node.id}</div>
      <div className="k">label</div>
      <input value={node.label} maxLength={30} onChange={(e) => onChange({ label: e.target.value || node.label })} />
      <div className="k">type</div>
      <select value={node.type} onChange={(e) => onChange({ type: e.target.value as NodeType })} disabled={node.type === "mission"}>
        {NODE_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <div className="k">layer</div>
      <select value={node.layer} onChange={(e) => onChange({ layer: e.target.value as Layer })} disabled={node.type === "mission"}>
        {(["root", "harness", "swarm", "loop"] as Layer[]).map((l) => (
          <option key={l} value={l}>{l}</option>
        ))}
      </select>
      <div className="k">config (JSON — applied on blur)</div>
      <textarea
        value={configText}
        placeholder={TYPE_HINTS[node.type].example}
        onChange={(e) => setConfigText(e.target.value)}
        onBlur={() => {
          try {
            onChange({ config: JSON.parse(configText || "{}") });
            setConfigError(null);
          } catch (err) {
            setConfigError((err as Error).message);
          }
        }}
      />
      {configError && <div className="error">invalid JSON: {configError}</div>}
      <div className="hintbox">
        <b>what goes here:</b> {TYPE_HINTS[node.type].hint}
        <div className="hintexample">e.g. {TYPE_HINTS[node.type].example}</div>
      </div>

      <div className="k">out of ideas?</div>
      <button className="btn" onClick={() => void requestDraft()} disabled={drafting}>
        {drafting ? "drafting…" : "✎ let the AI draft this node"}
      </button>
      {draftError && <div className="error">{draftError}</div>}
      {draft && (
        <div className="draftbox">
          <div>{draft}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                onChange({ config: { ...node.config, notes: draft } });
                setDraft(null);
              }}
            >
              apply to config.notes
            </button>
            <button className="btn" onClick={() => setDraft(null)}>discard</button>
          </div>
        </div>
      )}
      <div className="k">connections</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--ink-soft)" }}>
        {inbound.map((e, i) => (
          <div key={`in-${i}`}>← {e.from} ({e.kind})</div>
        ))}
        {outbound.map((e, i) => (
          <div key={`out-${i}`}>→ {e.to} ({e.kind})</div>
        ))}
        {inbound.length + outbound.length === 0 && <div>none</div>}
      </div>
    </>
  );
}
