import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, open, readFile, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';

const WORKTREE_LOCKS_DIR_NAME = '.locks';
const WORKTREE_LOCK_TTL_MS = 15 * 60 * 1000;

interface WorktreeLockMetadata {
  version: 1;
  lockId: string;
  taskId: string;
  sanitizedTaskId: string;
  repoRoot: string;
  worktreeDir: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
  owner: {
    pid: number;
    host: string;
  };
  createdAt: string;
}

export type WorktreeStartupWarning =
  | {
    code: 'stale_lock_cleaned';
    message: string;
    previousOwner?: {
      pid: number;
      host: string;
      createdAt: string;
    };
  };

interface LockAcquireResult {
  lockPath: string;
  lockId: string;
  warnings: WorktreeStartupWarning[];
}

export class WorktreeLockError extends Error {
  readonly code: 'worktree_locked';
  readonly lockPath: string;
  readonly metadata?: {
    pid: number;
    host: string;
    createdAt: string;
  };

  constructor(message: string, lockPath: string, metadata?: { pid: number; host: string; createdAt: string }) {
    super(message);
    this.name = 'WorktreeLockError';
    this.code = 'worktree_locked';
    this.lockPath = lockPath;
    this.metadata = metadata;
  }
}

export interface WorktreeHandle {
  /** Absolute path to the worktree directory. */
  path: string;
  /** Branch name created for this worktree. */
  branch: string;
  /** Non-fatal startup warnings (for example stale lock recovery). */
  warnings?: WorktreeStartupWarning[];
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
  const locksDir = join(dir, WORKTREE_LOCKS_DIR_NAME);
  const lockPath = join(locksDir, `${sanitized}.lock`);

  await mkdir(dir, { recursive: true });
  await mkdir(locksDir, { recursive: true });

  const lockResult = await acquireWorktreeLock({
    lockPath,
    repoRoot,
    taskId,
    sanitizedTaskId: sanitized,
    worktreeDir: dir,
    worktreePath,
    branch,
    baseBranch,
  });

  let createdWorktree = false;
  try {
    // Create a new branch and worktree
    await git(repoRoot, ['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    createdWorktree = true;

    // Bootstrap dependencies for Node/pnpm repositories so agent validation
    // does not repeatedly pay install cost in fresh worktrees.
    await bootstrapWorktreeDependencies(worktreePath);
  } catch (error) {
    if (createdWorktree) {
      await cleanupCreatedWorktree(repoRoot, worktreePath, branch);
    }
    await releaseWorktreeLock(lockPath, lockResult.lockId).catch(() => {});
    throw error;
  }

  return {
    path: worktreePath,
    branch,
    warnings: lockResult.warnings,
    async cleanup() {
      await cleanupCreatedWorktree(repoRoot, worktreePath, branch);
      await releaseWorktreeLock(lockResult.lockPath, lockResult.lockId).catch(() => {});
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

async function bootstrapWorktreeDependencies(worktreePath: string): Promise<void> {
  const lockfilePath = join(worktreePath, 'pnpm-lock.yaml');
  const nodeModulesPath = join(worktreePath, 'node_modules');
  if (!(await pathExists(lockfilePath))) {
    return;
  }
  if (await pathExists(nodeModulesPath)) {
    return;
  }

  try {
    await runCommand('pnpm', ['install', '--frozen-lockfile'], worktreePath, 180_000);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Dependency bootstrap failed for worktree at ${worktreePath}. Tried: pnpm install --frozen-lockfile\n${reason}`,
    );
  }
}

async function cleanupCreatedWorktree(repoRoot: string, worktreePath: string, branch: string): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', worktreePath, '--force']).catch(() => {});
  await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
  await git(repoRoot, ['branch', '-D', branch]).catch(() => {});
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function acquireWorktreeLock(options: {
  lockPath: string;
  repoRoot: string;
  taskId: string;
  sanitizedTaskId: string;
  worktreeDir: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): Promise<LockAcquireResult> {
  const warnings: WorktreeStartupWarning[] = [];

  while (true) {
    const lockId = randomUUID();
    const metadata: WorktreeLockMetadata = {
      version: 1,
      lockId,
      taskId: options.taskId,
      sanitizedTaskId: options.sanitizedTaskId,
      repoRoot: options.repoRoot,
      worktreeDir: options.worktreeDir,
      worktreePath: options.worktreePath,
      branch: options.branch,
      baseBranch: options.baseBranch,
      owner: {
        pid: process.pid,
        host: hostname(),
      },
      createdAt: new Date().toISOString(),
    };

    try {
      const handle = await open(options.lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(JSON.stringify(metadata, null, 2), { encoding: 'utf8' });
      } finally {
        await handle.close();
      }
      return {
        lockPath: options.lockPath,
        lockId,
        warnings,
      };
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      const existing = await readLockMetadata(options.lockPath);
      if (!existing) {
        // lock file disappeared between create and read; retry immediately.
        continue;
      }

      const stale = await isStaleLock(existing);
      if (!stale) {
        throw new WorktreeLockError(
          `Worktree is already locked by pid ${existing.owner.pid} on ${existing.owner.host}`,
          options.lockPath,
          {
            pid: existing.owner.pid,
            host: existing.owner.host,
            createdAt: existing.createdAt,
          },
        );
      }

      await rm(options.lockPath, { force: true });
      warnings.push({
        code: 'stale_lock_cleaned',
        message: `Cleaned stale worktree lock for ${options.sanitizedTaskId} (pid ${existing.owner.pid} on ${existing.owner.host}).`,
        previousOwner: {
          pid: existing.owner.pid,
          host: existing.owner.host,
          createdAt: existing.createdAt,
        },
      });
    }
  }
}

async function readLockMetadata(lockPath: string): Promise<WorktreeLockMetadata | undefined> {
  try {
    const data = await readFile(lockPath, 'utf8');
    const parsed = JSON.parse(data) as Partial<WorktreeLockMetadata>;
    if (
      parsed
      && parsed.version === 1
      && typeof parsed.lockId === 'string'
      && typeof parsed.createdAt === 'string'
      && typeof parsed.taskId === 'string'
      && typeof parsed.sanitizedTaskId === 'string'
      && parsed.owner
      && typeof parsed.owner.pid === 'number'
      && typeof parsed.owner.host === 'string'
    ) {
      return parsed as WorktreeLockMetadata;
    }
    return undefined;
  } catch (error) {
    if (isNoEntryError(error)) {
      return undefined;
    }
    return undefined;
  }
}

async function isStaleLock(metadata: WorktreeLockMetadata): Promise<boolean> {
  const ageMs = Date.now() - Date.parse(metadata.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return false;
  }

  if (ageMs >= WORKTREE_LOCK_TTL_MS) {
    return true;
  }

  if (metadata.owner.host === hostname()) {
    try {
      process.kill(metadata.owner.pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  return false;
}

async function releaseWorktreeLock(lockPath: string, lockId: string): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (!metadata) {
    return;
  }
  if (metadata.lockId !== lockId) {
    return;
  }
  await rm(lockPath, { force: true });
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'EEXIST',
  );
}

function isNoEntryError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT',
  );
}

function git(cwd: string, args: string[]): Promise<string> {
  return runCommand('git', args, cwd, 30_000);
}

function runCommand(command: string, args: string[], cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed:\n${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}