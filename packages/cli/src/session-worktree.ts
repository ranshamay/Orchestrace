import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import {
  cleanupWorktree,
  ensureWorktreeExists,
  resolveManagedWorktreeBaseDir,
} from '@orchestrace/sandbox';
import { WORKSPACE_RUNTIME_CRITICAL_PATHS } from './workspace-runtime.js';

export interface SessionWorktreeState {
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  created: boolean;
  recreated: boolean;
}

export function resolveSessionWorktreeBranch(sessionId: string): string {
  return `orchestrace/session-${sanitizeSegment(sessionId)}`;
}

export function resolveSessionWorktreePath(repoRoot: string, sessionId: string): string {
  const resolvedRepoRoot = resolve(repoRoot);
  const repoLabel = sanitizeSegment(basename(resolvedRepoRoot) || 'workspace');
  const repoHash = createHash('sha1').update(resolvedRepoRoot).digest('hex').slice(0, 10);
  return join(
    resolveManagedWorktreeBaseDir(resolvedRepoRoot),
    `${repoLabel}-${repoHash}`,
    `session-${sanitizeSegment(sessionId)}`,
  );
}

export async function ensureSessionWorktree(params: {
  repoRoot: string;
  sessionId: string;
  worktreePath?: string;
  branchName?: string;
}): Promise<SessionWorktreeState> {
  const repoRoot = resolve(params.repoRoot);
  const branchName = params.branchName?.trim() || resolveSessionWorktreeBranch(params.sessionId);
  const worktreePath = params.worktreePath?.trim()
    ? resolve(params.worktreePath)
    : resolveSessionWorktreePath(repoRoot, params.sessionId);

    const ensured = await ensureWorktreeExists({
    repoPath: repoRoot,
    branchName,
    worktreePath,
    requiredPaths: WORKSPACE_RUNTIME_CRITICAL_PATHS,
  });

  return {
    repoRoot,
    worktreePath: ensured.path,
    branchName: ensured.branch,
    created: ensured.created,
    recreated: ensured.recreated,
  };
}

export async function cleanupSessionWorktree(params: {
  repoRoot: string;
  sessionId: string;
  worktreePath?: string;
  branchName?: string;
}): Promise<void> {
  const repoRoot = resolve(params.repoRoot);
  const worktreePath = params.worktreePath?.trim()
    ? resolve(params.worktreePath)
    : resolveSessionWorktreePath(repoRoot, params.sessionId);
  const branchName = params.branchName?.trim() || resolveSessionWorktreeBranch(params.sessionId);

  await cleanupWorktree({
    repoPath: repoRoot,
    worktreePath,
    branchName,
  });
}

function sanitizeSegment(value: string): string {
  const sanitized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'session';
}