import { z } from "zod";
import { MissionLabelsSchema, type MissionLabels } from "@arbor/schema";

export const CONFIDENCE_THRESHOLD = 0.8;

const CompiledFieldSchema = z.object({
  value: z.unknown(),
  confidence: z.number().min(0).max(1),
  source: z.string().nullable().default(null),
});

const CompiledLabelsSchema = z.object({
  goal: CompiledFieldSchema,
  context: CompiledFieldSchema,
  out_of_scope: CompiledFieldSchema,
  metric_scope: CompiledFieldSchema,
  budget: CompiledFieldSchema,
  trigger: CompiledFieldSchema,
});

export interface CompiledLabelReport {
  field: string;
  value: unknown;
  confidence: number;
  source: string | null;
  needsConfirm: boolean;
}

export interface CompileResult {
  labels: MissionLabels;
  report: CompiledLabelReport[];
  flagged: boolean;
}

/** JSON schema sent to the API (structured outputs — no free-form parsing). */
const LABELS_JSON_SCHEMA = {
  type: "object",
  properties: {
    goal: field({ type: "string" }),
    context: field({ type: "array", items: { type: "string" } }),
    out_of_scope: field({ type: "array", items: { type: "string" } }),
    metric_scope: field({
      type: "object",
      properties: {
        metric: { type: "string" },
        threshold: { type: "string" },
        surface: { type: "array", items: { type: "string" } },
      },
      required: ["metric", "threshold", "surface"],
      additionalProperties: false,
    }),
    budget: field({
      type: "object",
      properties: {
        max_iterations: { type: "integer" },
        cost_ceiling_usd: { type: "number" },
        no_progress_window: { type: "integer" },
      },
      required: ["max_iterations", "cost_ceiling_usd", "no_progress_window"],
      additionalProperties: false,
    }),
    trigger: field({ type: "string", enum: ["manual", "cron", "event"] }),
  },
  required: ["goal", "context", "out_of_scope", "metric_scope", "budget", "trigger"],
  additionalProperties: false,
} as const;

function field(valueSchema: Record<string, unknown>) {
  return {
    type: "object",
    properties: {
      value: valueSchema,
      confidence: { type: "number" },
      source: { type: ["string", "null"] },
    },
    required: ["value", "confidence", "source"],
    additionalProperties: false,
  };
}

const COMPILER_PROMPT = `You are the label compiler for ARBOR, a controlled autonomous dev system.
The user describes a mission in plain language. Extract structured labels from it.

Rules:
- goal: what "done" means, as a checkable outcome (not a vibe).
- metric_scope.metric: a shell command whose exit code verifies the goal (e.g. "npm test", "node --test", "pytest -q"). If the user names a stack, pick its standard test command; threshold is "exit 0".
- budget: extract explicit limits ("stop at $10" -> cost_ceiling_usd: 10). Where the user is silent, use conservative defaults: max_iterations 8, cost_ceiling_usd 10, no_progress_window 2. Never unlimited.
- trigger: "overnight"/"nightly" -> cron; "when CI fails" -> event; otherwise manual.
- out_of_scope: anything the user says not to touch.
- For each field give confidence (0-1) and quote the exact source span of the user's text it came from (null if defaulted).
- Set confidence below 0.8 for anything you had to guess (e.g. the test command when the stack is unclear).

Mission description:
`;

/** Deterministic canned output so tests and demos run offline. */
function fixtureCompile(input: string): z.infer<typeof CompiledLabelsSchema> {
  const costMatch = input.match(/\$\s?(\d+(?:\.\d+)?)/);
  return {
    goal: { value: "make the test suite green", confidence: 0.95, source: input.slice(0, 60) },
    context: { value: [], confidence: 0.6, source: null },
    out_of_scope: { value: [], confidence: 0.9, source: null },
    metric_scope: {
      value: { metric: "node --test", threshold: "exit 0", surface: [] },
      confidence: 0.75,
      source: null,
    },
    budget: {
      value: {
        max_iterations: 8,
        cost_ceiling_usd: costMatch ? Number(costMatch[1]) : 10,
        no_progress_window: 2,
      },
      confidence: costMatch ? 0.95 : 0.7,
      source: costMatch ? costMatch[0] : null,
    },
    trigger: { value: /overnight|nightly/i.test(input) ? "cron" : "manual", confidence: 0.9, source: null },
  };
}

async function llmCompile(input: string): Promise<z.infer<typeof CompiledLabelsSchema>> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error("no Anthropic credentials — set ANTHROPIC_API_KEY or use --fixture");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: { type: "json_schema", schema: LABELS_JSON_SCHEMA as unknown as Record<string, unknown> } },
    messages: [{ role: "user", content: COMPILER_PROMPT + input }],
  } as Parameters<typeof client.messages.create>[0]);
  const message = response as { content: Array<{ type: string; text?: string }> };
  const text = message.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("label compiler returned no text block");
  return CompiledLabelsSchema.parse(JSON.parse(text));
}

/**
 * One premium-model pass: freeform mission text -> mission labels with
 * per-label confidence and source spans. Anything under the threshold is
 * flagged; the CLI blocks the run until the user confirms (invariant 1:
 * an unconfirmed goal never compiles to success criteria).
 */
export async function compileLabels(input: string, opts: { fixture?: boolean } = {}): Promise<CompileResult> {
  const compiled = opts.fixture ? fixtureCompile(input) : await llmCompile(input);

  const labels = MissionLabelsSchema.parse({
    goal: compiled.goal.value,
    context: compiled.context.value,
    out_of_scope: compiled.out_of_scope.value,
    metric_scope: compiled.metric_scope.value,
    budget: compiled.budget.value,
    trigger: compiled.trigger.value,
  });

  const report: CompiledLabelReport[] = Object.entries(compiled).map(([fieldName, f]) => ({
    field: fieldName,
    value: f.value,
    confidence: f.confidence,
    source: f.source,
    needsConfirm: f.confidence < CONFIDENCE_THRESHOLD,
  }));

  return { labels, report, flagged: report.some((r) => r.needsConfirm) };
}
