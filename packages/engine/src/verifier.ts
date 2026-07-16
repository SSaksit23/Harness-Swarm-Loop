import { execa } from "execa";
import type { CheckResult, SuccessCriterion, Verdict } from "@arbor/schema";

const CHECK_TIMEOUT_MS = 5 * 60_000;
const MAX_OUTPUT_CHARS = 4_000;

export interface VerifierResult {
  verdict: Verdict;
  checks: CheckResult[];
}

/**
 * The thing that says no. Runs every success criterion as a real command in
 * the sandbox and trusts only exit codes — never the agent's claims.
 */
export async function runChecks(criteria: SuccessCriterion[], cwd: string): Promise<VerifierResult> {
  const checks: CheckResult[] = [];
  for (const criterion of criteria) {
    try {
      const res = await execa(criterion.check, {
        shell: true,
        cwd,
        reject: false,
        timeout: CHECK_TIMEOUT_MS,
        all: true,
      });
      const output = (res.all ?? "").slice(-MAX_OUTPUT_CHARS);
      checks.push({
        criterion: criterion.id,
        ok: res.exitCode === 0,
        exit_code: res.exitCode ?? null,
        output,
      });
    } catch (err) {
      checks.push({
        criterion: criterion.id,
        ok: false,
        exit_code: null,
        output: `verifier failed to run check: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return { verdict: checks.every((c) => c.ok) ? "pass" : "fail", checks };
}
