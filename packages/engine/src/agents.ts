export interface AgentExecuteOptions {
  prompt: string;
  cwd: string;
  onThought?: (text: string) => void;
}

export interface AgentResult {
  summary: string;
  costUsd: number;
  tokens: number;
}

export interface AgentExecutor {
  readonly name: string;
  execute(opts: AgentExecuteOptions): Promise<AgentResult>;
}

export const MODEL_TIERS = {
  premium: "claude-opus-4-8",
  cheap: "claude-haiku-4-5",
} as const;

export interface ResolvedModels {
  /** Orchestrator / label compiler / node writer — the controller. */
  plan: string;
  /** Sequential agent and swarm workers — the implementer. */
  execute: string;
}

/**
 * Model tiers are tree configuration, not code: the orchestrator node's
 * config.model plans, the worker node's config.model implements. An explicit
 * override (CLI --model / API body) wins over both; hardcoded tiers are the
 * last resort.
 */
export function resolveModels(
  tree: { nodes: Array<{ type: string; config: Record<string, unknown> }> },
  override?: string,
): ResolvedModels {
  const configModel = (type: string): string | undefined => {
    const value = tree.nodes.find((n) => n.type === type)?.config?.model;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    plan: override ?? configModel("orchestrator") ?? MODEL_TIERS.premium,
    execute: override ?? configModel("worker") ?? MODEL_TIERS.premium,
  };
}

/**
 * Real executor: one Claude Agent SDK session per tick, sandboxed to the
 * working directory. The SDK supplies the harness (Read/Write/Edit/Bash/...);
 * ARBOR supplies the control layer around it.
 */
export class SdkAgent implements AgentExecutor {
  readonly name = "claude-agent";

  constructor(
    private readonly model: string = MODEL_TIERS.premium,
    private readonly maxTurns = 60,
  ) {}

  async execute({ prompt, cwd, onThought }: AgentExecuteOptions): Promise<AgentResult> {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        "no Anthropic credentials found — set ANTHROPIC_API_KEY (see .env.example) or use --mock",
      );
    }
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let costUsd = 0;
    let tokens = 0;
    let summary = "";

    const stream = query({
      prompt,
      options: {
        cwd,
        model: this.model,
        maxTurns: this.maxTurns,
        // The filesystem sandbox (git worktree) is ARBOR's isolation boundary;
        // inside it the agent may edit and run freely.
        permissionMode: "bypassPermissions",
      },
    });

    for await (const message of stream) {
      const m = message as Record<string, any>;
      if (m.type === "assistant") {
        const blocks: any[] = m.message?.content ?? [];
        for (const block of blocks) {
          if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            onThought?.(block.text.trim().slice(0, 300));
          }
        }
      } else if (m.type === "result") {
        costUsd = typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0;
        const usage = m.usage ?? {};
        tokens =
          (usage.input_tokens ?? 0) +
          (usage.output_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0);
        summary = typeof m.result === "string" ? m.result : "";
      }
    }
    return { summary, costUsd, tokens };
  }
}

export type ScriptStep = (cwd: string) => void | Partial<AgentResult> | Promise<void | Partial<AgentResult>>;

/**
 * Deterministic executor for tests and offline runs: each tick consumes the
 * next step of the script; steps may modify files in the sandbox. When the
 * script is exhausted the agent does nothing (useful for hard-stop tests).
 */
export class ScriptedAgent implements AgentExecutor {
  readonly name = "scripted-agent";
  private step = 0;

  constructor(
    private readonly script: ScriptStep[] = [],
    private readonly costPerTickUsd = 0.5,
  ) {}

  async execute({ cwd, onThought }: AgentExecuteOptions): Promise<AgentResult> {
    const fn: ScriptStep | undefined = this.script[this.step];
    const hasStep = fn !== undefined;
    this.step += 1;
    let overrides: Partial<AgentResult> = {};
    if (hasStep) {
      overrides = (await fn(cwd)) ?? {};
    }
    onThought?.(hasStep ? `scripted step ${this.step} applied` : "no scripted step left — noop");
    return {
      summary: overrides.summary ?? (hasStep ? `scripted step ${this.step}` : "noop"),
      costUsd: overrides.costUsd ?? this.costPerTickUsd,
      tokens: overrides.tokens ?? 1_000,
    };
  }
}
