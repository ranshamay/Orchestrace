import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** Clean up: remove worktree and delete the branch. */
  cleanup(): Promise<void>;
}

/**
 * Create an isolated git worktree for a task.
 * Each worktree gets its own branch so parallel agents can make
 * non-conflicting changes to the same repo.
 */
export async function createWorktree(
  repoRoot: string,
  taskId: string,
  baseBranch = 'HEAD',
  worktreeDir?: string,
): Promise<WorktreeHandle> {
  const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const branch = `orchestrace/${sanitized}`;
  const dir = worktreeDir ?? join(repoRoot, '.worktrees');
  const worktreePath = join(dir, sanitized);

  await mkdir(dir, { recursive: true });

  // Create a new branch and worktree
  await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);

  return {
    path: worktreePath,
    branch,
    async cleanup() {
      await git(repoRoot, ['worktree', 'remove', worktreePath, '--force']).catch(() => {});
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      await git(repoRoot, ['branch', '-D', branch]).catch(() => {});
    },
  };
}

/**
 * List all active worktrees.
 */
export async function listWorktrees(repoRoot: string): Promise<string[]> {
  const output = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

/**
 * Merge a worktree branch back into the target branch.
 */
export async function mergeWorktree(
  repoRoot: string,
  handle: WorktreeHandle,
  targetBranch = 'main',
): Promise<{ merged: boolean; conflicts: boolean }> {
  try {
    await git(repoRoot, ['checkout', targetBranch]);
    await git(repoRoot, ['merge', handle.branch, '--no-edit']);
    return { merged: true, conflicts: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('CONFLICT')) {
      return { merged: false, conflicts: true };
    }
    throw err;
  }
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${args.join(' ')} failed:\n${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}
