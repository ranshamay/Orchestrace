import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

export interface WorkspaceRuntimeValidationResult {
  normalizedPath: string;
  missingExpectedDirs: string[];
  missingCriticalPaths: string[];
}

const EXPECTED_SOURCE_DIRS = [
  'packages/tools/src',
  'packages/cli/src',
] as const;

export const WORKSPACE_RUNTIME_CRITICAL_PATHS = [
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'vitest.config.ts',
  'packages/cli/src/runner.ts',
  'packages/cli/src/ui-server.ts',
  'packages/tools/src/index.ts',
  'packages/cli/tests/workspace-runtime.test.ts',
  'packages/tools/tests/toolset.test.ts',
] as const;

export async function validateWorkspaceRuntime(workspacePath: string): Promise<WorkspaceRuntimeValidationResult> {
  const trimmed = workspacePath.trim();
  if (!trimmed) {
    throw new Error('Workspace path cannot be empty.');
  }

  const resolved = resolve(trimmed);
  let normalizedPath: string;
  try {
    normalizedPath = await realpath(resolved);
  } catch {
    normalizedPath = resolved;
  }

  try {
    await access(normalizedPath, constants.F_OK | constants.R_OK);
  } catch {
    throw new Error(`Workspace path is not accessible: ${normalizedPath}`);
  }

  const missingExpectedDirs: string[] = [];
  for (const expectedDir of EXPECTED_SOURCE_DIRS) {
    try {
      await access(join(normalizedPath, expectedDir), constants.F_OK | constants.R_OK);
    } catch {
      missingExpectedDirs.push(expectedDir);
    }
  }

  const missingCriticalPaths: string[] = [];
  for (const criticalPath of WORKSPACE_RUNTIME_CRITICAL_PATHS) {
    try {
      await access(join(normalizedPath, criticalPath), constants.F_OK | constants.R_OK);
    } catch {
      missingCriticalPaths.push(criticalPath);
    }
  }

  return {
    normalizedPath,
    missingExpectedDirs,
    missingCriticalPaths,
  };
}

export function formatMissingSourceDirsWarning(workspacePath: string, missingDirs: string[]): string | undefined {
  if (missingDirs.length === 0) {
    return undefined;
  }

  return [
    `Workspace runtime check: expected source directories missing under cwd ${workspacePath}.`,
    `Missing: ${missingDirs.join(', ')}`,
    'This can indicate a worktree/root mismatch or missing container bind mount.',
  ].join(' ');
}

export function formatMissingCriticalPathsError(workspacePath: string, missingPaths: string[]): string | undefined {
  if (missingPaths.length === 0) {
    return undefined;
  }

  return [
    `Workspace runtime check failed: critical source/test/config files missing under cwd ${workspacePath}.`,
    `Missing critical paths: ${missingPaths.join(', ')}`,
    'Session startup is blocked until workspace initialization recreates or repopulates these files.',
  ].join(' ');
}

export function assertWorkspaceRuntimeIsComplete(result: WorkspaceRuntimeValidationResult): void {
  const criticalPathError = formatMissingCriticalPathsError(result.normalizedPath, result.missingCriticalPaths);
  if (criticalPathError) {
    throw new Error(criticalPathError);
  }
}