import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { ArborTreeSchema, MissionLabelsSchema, buildZip, defaultTree, treeToMarkdownFiles, validateInvariants } from "@arbor/schema";
import { FileStore, openMemoryStore } from "@arbor/store";
import {
  EventBus,
  LlmPlanner,
  ScriptedAgent,
  SdkAgent,
  compileLabels,
  curate,
  resolveModels,
  runLoop,
  suggestNodeText,
  type ArborEvent,
  type CheckinAction,
  type CheckinReport,
  type HumanGate,
  type SwarmOptions,
} from "@arbor/engine";

export interface ArborServer {
  server: http.Server;
  port: number;
  stop(): Promise<void>;
}

interface RunRequest {
  mode?: "mock" | "real" | "swarm";
  model?: string;
  workers?: number;
}

interface PendingCheckin {
  report: CheckinReport;
  resolve: (action: CheckinAction) => void;
}

const WORKBENCH_DIST = fileURLToPath(new URL("../../../apps/workbench/dist", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * The workbench backend: a thin HTTP+WebSocket layer over the same file store
 * and engine the CLI uses. The UI never gets a second mental model — it reads
 * and writes tree.json, tick records, and memory files, and watches the same
 * event bus the terminal renders.
 */
export function createArborServer(projectDir: string): ArborServer {
  const files = new FileStore(projectDir);
  files.init();

  const sockets = new Set<WebSocket>();
  let running = false;
  let pendingCheckin: PendingCheckin | null = null;

  const broadcast = (event: ArborEvent | { type: "run_error"; message: string } | { type: "run_state"; running: boolean }) => {
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
    }
  };

  const startRun = (body: RunRequest): { ok: true } | { ok: false; error: string } => {
    if (running) return { ok: false, error: "a run is already in progress" };
    if (!files.hasTree()) return { ok: false, error: "no tree planted — save one from the canvas or run `arbor plant`" };

    const mode = body.mode ?? "mock";
    const models = resolveModels(files.readTree(), body.model);
    const executor = mode === "mock" ? new ScriptedAgent([], 0.25) : new SdkAgent(models.execute);
    const swarm: SwarmOptions | undefined =
      mode === "swarm"
        ? {
            planner: new LlmPlanner(models.plan),
            makeWorker: () => new SdkAgent(models.execute),
            maxParallel: Math.max(1, body.workers ?? 3),
          }
        : undefined;

    const events = new EventBus();
    events.on(broadcast);
    running = true;
    broadcast({ type: "run_state", running: true });

    // The runner emits the `checkin` event itself; the server just parks the
    // resolver until POST /api/checkin (or the engine-side timeout) answers.
    const humanGate: HumanGate = {
      ask: (report) =>
        new Promise<CheckinAction>((resolve) => {
          pendingCheckin = {
            report,
            resolve: (action) => {
              pendingCheckin = null;
              resolve(action);
            },
          };
        }),
    };

    void (async () => {
      const memory = await openMemoryStore(files, path.basename(projectDir));
      try {
        const tree = files.readTree();
        await runLoop({ projectDir, tree, files, memory, executor, events, swarm, humanGate });
      } catch (err) {
        broadcast({ type: "run_error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        await memory.close();
        running = false;
        pendingCheckin = null;
        broadcast({ type: "run_state", running: false });
      }
    })();
    return { ok: true };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
        const planted = files.hasTree();
        const tree = planted ? files.readTree() : null;
        return json(res, 200, {
          planted,
          running,
          goal: tree?.labels.goal ?? null,
          budget: tree?.labels.budget ?? null,
          project: path.basename(projectDir),
          checkin: pendingCheckin?.report ?? null,
        });
      }
      if (url.pathname === "/api/tree" && req.method === "GET") {
        if (!files.hasTree()) return json(res, 404, { error: "no tree planted" });
        return json(res, 200, files.readTree());
      }
      if (url.pathname === "/api/tree" && req.method === "PUT") {
        const body = await readBody(req);
        const parsed = ArborTreeSchema.safeParse(body);
        if (!parsed.success) {
          return json(res, 400, {
            error: "tree does not match the schema",
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        files.writeTree(parsed.data);
        // Free wiring is allowed while sketching — invariant violations are
        // advisory on save; the engine hard-refuses them at run time.
        return json(res, 200, { ok: true, violations: validateInvariants(parsed.data) });
      }
      if (url.pathname === "/api/ticks" && req.method === "GET") {
        return json(res, 200, files.readTicks());
      }
      if (url.pathname === "/api/memory" && req.method === "GET") {
        const memory = await openMemoryStore(files, path.basename(projectDir));
        try {
          const usage = new Map((await memory.listIndexed()).map((r) => [r.name, r]));
          const entries = files.listMemoryEntries().map((e) => ({
            ...e,
            usage_count: usage.get(e.name)?.usage_count ?? 0,
            last_used: usage.get(e.name)?.last_used ?? null,
          }));
          entries.sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name));
          return json(res, 200, entries);
        } finally {
          await memory.close();
        }
      }
      if (url.pathname === "/api/skills" && req.method === "GET") {
        return json(res, 200, files.listSkills());
      }
      if (url.pathname === "/api/skills/install" && req.method === "POST") {
        const body = (await readBody(req)) as { filename?: string; data_base64?: string };
        if (!body.filename || !body.data_base64) {
          return json(res, 400, { error: "filename and data_base64 are required" });
        }
        let buffer: Buffer;
        try {
          buffer = Buffer.from(body.data_base64, "base64");
        } catch {
          return json(res, 400, { error: "data_base64 is not valid base64" });
        }
        if (buffer.length > 16 * 1024 * 1024) return json(res, 400, { error: "upload exceeds the 16MB cap" });
        try {
          const { installSkill } = await import("./install.js");
          const result = await installSkill(files, body.filename, buffer);
          return json(res, 200, { ok: true, ...result });
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (url.pathname === "/api/curate" && req.method === "POST") {
        const body = (await readBody(req)) as { prune?: boolean; minUsage?: number };
        const memory = await openMemoryStore(files, path.basename(projectDir));
        try {
          const report = await curate(files, memory, {
            prune: body.prune === true,
            minUsageForSkill: body.minUsage,
          });
          return json(res, 200, report);
        } finally {
          await memory.close();
        }
      }
      if (url.pathname === "/api/plant/compile" && req.method === "POST") {
        const body = (await readBody(req)) as { mission?: string; fixture?: boolean };
        if (!body.mission?.trim()) return json(res, 400, { error: "mission text is required" });
        try {
          // one premium-model pass: plain language -> labels + confidence report
          const result = await compileLabels(body.mission.trim(), { fixture: body.fixture });
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }
      if (url.pathname === "/api/plant" && req.method === "POST") {
        if (running) return json(res, 409, { error: "a run is in progress — stop it before replanting" });
        const body = (await readBody(req)) as { labels?: unknown };
        const parsed = MissionLabelsSchema.safeParse(body.labels);
        if (!parsed.success) {
          return json(res, 400, {
            error: "labels do not match the schema",
            issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
        }
        const tree = defaultTree(parsed.data);
        const violations = validateInvariants(tree);
        if (violations.length) {
          return json(res, 400, {
            error: "compiled tree violates the control invariants",
            issues: violations.map((v) => `[rule ${v.rule}] ${v.message}`),
          });
        }
        files.writeTree(tree);
        return json(res, 200, { ok: true, goal: parsed.data.goal });
      }
      if (url.pathname === "/api/run" && req.method === "POST") {
        const result = startRun((await readBody(req)) as RunRequest);
        return json(res, result.ok ? 202 : 409, result);
      }
      if (url.pathname === "/api/checkin" && req.method === "POST") {
        const body = (await readBody(req)) as { action?: string; note?: string };
        if (!pendingCheckin) return json(res, 409, { error: "no check-in is waiting for an answer" });
        const action = body.action === "stop" || body.action === "revise" ? body.action : "continue";
        pendingCheckin.resolve({ action, note: body.note });
        return json(res, 200, { ok: true });
      }
      // per-node attachments: GET/POST /api/nodes/:id/attachments, DELETE .../:name
      const attachMatch = url.pathname.match(/^\/api\/nodes\/([^/]+)\/attachments(?:\/([^/]+))?$/);
      if (attachMatch) {
        const nodeId = decodeURIComponent(attachMatch[1]);
        const attachmentName = attachMatch[2] ? decodeURIComponent(attachMatch[2]) : null;
        if (!files.hasTree()) return json(res, 404, { error: "no tree planted" });
        if (!files.readTree().nodes.some((n) => n.id === nodeId)) {
          return json(res, 404, { error: `no node with id "${nodeId}"` });
        }
        if (req.method === "GET" && !attachmentName) {
          return json(res, 200, files.listAttachments(nodeId));
        }
        if (req.method === "POST" && !attachmentName) {
          const body = (await readBody(req)) as { filename?: string; content?: string };
          if (!body.filename || typeof body.content !== "string") {
            return json(res, 400, { error: "filename and content are required" });
          }
          try {
            const saved = files.writeAttachment(nodeId, body.filename, body.content);
            return json(res, 200, { ok: true, name: saved.name, size: saved.size });
          } catch (err) {
            return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        }
        if (req.method === "DELETE" && attachmentName) {
          const removed = files.deleteAttachment(nodeId, attachmentName);
          return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: "no such attachment" });
        }
        return json(res, 405, { error: "method not allowed" });
      }

      if (url.pathname === "/api/export.zip" && req.method === "GET") {
        if (!files.hasTree()) return json(res, 404, { error: "no tree planted" });
        const zip = buildZip(treeToMarkdownFiles(files.readTree(), files.attachmentsByNode()));
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="arbor-${path.basename(projectDir)}.zip"`,
          "content-length": zip.length,
        });
        return res.end(Buffer.from(zip));
      }
      if (url.pathname === "/api/suggest" && req.method === "POST") {
        if (!files.hasTree()) return json(res, 404, { error: "no tree planted" });
        const body = (await readBody(req)) as { nodeId?: string; fixture?: boolean };
        if (!body.nodeId) return json(res, 400, { error: "nodeId is required" });
        try {
          const result = await suggestNodeText(files.readTree(), body.nodeId, {
            fixture: body.fixture,
            attachments: files.attachmentsByNode(),
          });
          return json(res, 200, result);
        } catch (err) {
          return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Static workbench (built) or a hint page.
      if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
        const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const file = path.join(WORKBENCH_DIST, path.normalize(rel));
        if (file.startsWith(WORKBENCH_DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
          return void fs.createReadStream(file).pipe(res);
        }
        if (fs.existsSync(path.join(WORKBENCH_DIST, "index.html"))) {
          res.writeHead(200, { "content-type": MIME[".html"] });
          return void fs.createReadStream(path.join(WORKBENCH_DIST, "index.html")).pipe(res);
        }
        res.writeHead(200, { "content-type": MIME[".html"] });
        return res.end(
          `<title>arbor serve</title><body style="font-family:ui-monospace,monospace;padding:2rem"><h1>arbor serve</h1><p>API is up. The workbench isn't built yet — run <code>npm run dev -w apps/workbench</code> for the dev UI (it proxies here), or <code>npm run build -w apps/workbench</code> to serve it from this port.</p></body>`,
        );
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    ws.send(JSON.stringify({ type: "run_state", running }));
    ws.on("close", () => sockets.delete(ws));
  });

  return {
    server,
    get port() {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close(() => server.close(() => resolve()));
      }),
  };
}
