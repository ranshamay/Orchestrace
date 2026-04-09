import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

export interface WorkspaceRuntimeValidationResult {
  normalizedPath: string;
  missingExpectedDirs: string[];
}

const EXPECTED_SOURCE_DIRS = [
  'packages/tools/src',
  'packages/cli/src',
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

  return {
    normalizedPath,
    missingExpectedDirs,
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