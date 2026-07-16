import fs from "node:fs";
import path from "node:path";
import { execa } from "execa";

export interface Sandbox {
  /** Directory the agent and verifier operate in. */
  dir: string;
  kind: "worktree" | "in-place";
  branch: string | null;
  /** Commit results (worktree mode) and clean up. Returns the branch name holding the changes. */
  finalize(message: string): Promise<string | null>;
}

export async function git(args: string[], cwd: string) {
  return execa("git", args, { cwd, reject: false });
}

/** Stage and commit everything in `dir` if anything changed. Returns true when a commit was made. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(["add", "-A"], dir);
  const status = await git(["status", "--porcelain"], dir);
  if (!status.stdout.trim()) return false;
  const res = await git(["commit", "-m", message], dir);
  return res.exitCode === 0;
}

async function isGitRepo(dir: string): Promise<boolean> {
  const res = await git(["rev-parse", "--is-inside-work-tree"], dir);
  return res.exitCode === 0 && res.stdout.trim() === "true";
}

/**
 * Isolation boundary for a run. In a git repo, work happens on a dedicated
 * branch inside a temporary worktree — the user's checkout is never touched;
 * results land on `arbor/run-<id>` to review and merge. Outside git, the run
 * degrades to in-place execution (the caller is warned via `kind`).
 */
export async function createSandbox(projectDir: string, runId: string): Promise<Sandbox> {
  if (!(await isGitRepo(projectDir))) {
    return {
      dir: projectDir,
      kind: "in-place",
      branch: null,
      async finalize() {
        return null;
      },
    };
  }

  const branch = `arbor/run-${runId}`;
  const worktreeDir = path.join(projectDir, ".arbor-tmp", `run-${runId}`);
  fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

  const add = await git(["worktree", "add", "-b", branch, worktreeDir, "HEAD"], projectDir);
  if (add.exitCode !== 0) {
    throw new Error(`failed to create git worktree sandbox: ${add.stderr}`);
  }

  return {
    dir: worktreeDir,
    kind: "worktree",
    branch,
    async finalize(message: string) {
      // The arbor/ control dir lives in the main checkout, not the worktree —
      // only the agent's changes to the actual project get committed.
      await git(["add", "-A"], worktreeDir);
      const status = await git(["status", "--porcelain"], worktreeDir);
      if (status.stdout.trim()) {
        await git(["commit", "-m", message], worktreeDir);
      }
      await git(["worktree", "remove", "--force", worktreeDir], projectDir);
      fs.rmSync(path.dirname(worktreeDir), { recursive: true, force: true });
      return branch;
    },
  };
}
