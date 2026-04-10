import { exec } from 'node:child_process';
import { access } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TaskOutput, ValidationConfig, ValidationResult } from '../dag/types.js';

/**
 * Run validation commands against a task's output.
 * Returns individual results for each check.
 */
export async function validate(
  output: TaskOutput,
  config: ValidationConfig,
  cwd: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  if (config.commands) {
    try {
      await ensureDependenciesForValidation(cwd);
    } catch (dependencyError) {
      const message = dependencyError instanceof Error ? dependencyError.message : String(dependencyError);
      for (const command of config.commands) {
        results.push({
          command,
          passed: false,
          output: message,
          durationMs: 0,
        });
      }
      return results;
    }

    for (const command of config.commands) {
      const start = Date.now();
      try {
        const stdout = await runCommand(command, cwd);
        results.push({
          command,
          passed: true,
          output: stdout,
          durationMs: Date.now() - start,
        });
      } catch {
        // Flake detection: retry once before reporting failure
        try {
          const stdout = await runCommand(command, cwd);
          results.push({
            command,
            passed: true,
            output: stdout,
            durationMs: Date.now() - start,
          });
        } catch (retryErr) {
          results.push({
            command,
            passed: false,
            output: retryErr instanceof Error ? retryErr.message : String(retryErr),
            durationMs: Date.now() - start,
          });
        }
      }
    }
  }

  if (config.custom) {
    const start = Date.now();
    try {
      const passed = await config.custom(output);
      results.push({
        command: '<custom validator>',
        passed,
        output: passed ? 'passed' : 'failed',
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        command: '<custom validator>',
        passed: false,
        output: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  return results;
}

async function ensureDependenciesForValidation(cwd: string): Promise<void> {
  const lockfilePath = join(cwd, 'pnpm-lock.yaml');
  const nodeModulesPath = join(cwd, 'node_modules');

  if (!(await pathExists(lockfilePath))) {
    return;
  }
  if (await pathExists(nodeModulesPath)) {
    return;
  }

  await runCommand('pnpm install --frozen-lockfile', cwd);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

interface NormalizedValidationCommand {
  command: string;
  cwd: string;
}

function runCommand(command: string, cwd: string): Promise<string> {
  const normalized = normalizeValidationCommand(command, cwd, cwd);

  return new Promise((resolve, reject) => {
    exec(normalized.command, { cwd: normalized.cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${normalized.command} failed:\n${stderr || stdout || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function normalizeValidationCommand(command: string, baseCwd: string, workspaceRoot: string): NormalizedValidationCommand {
  const trimmed = command.trim();
  if (!trimmed) {
    return { command, cwd: baseCwd };
  }

  const tokens = tokenizeCommand(trimmed);
  if (tokens.length === 0 || tokens[0] !== 'pnpm') {
    return { command: trimmed, cwd: baseCwd };
  }

  let nextCwd = baseCwd;
  const normalizedTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? '';

    if (token === '-C' || token === '--dir') {
      const rawDir = tokens[i + 1];
      if (!rawDir) {
        throw new Error(`Invalid pnpm command: ${token} requires a directory value.`);
      }
      nextCwd = resolvePnpmDirectory(workspaceRoot, nextCwd, rawDir, token);
      i += 1;
      continue;
    }

    if (token.startsWith('--dir=')) {
      const rawDir = token.slice('--dir='.length);
      if (!rawDir) {
        throw new Error('Invalid pnpm command: --dir requires a non-empty directory value.');
      }
      nextCwd = resolvePnpmDirectory(workspaceRoot, nextCwd, rawDir, '--dir');
      continue;
    }

    if (token.startsWith('-C=')) {
      const rawDir = token.slice('-C='.length);
      if (!rawDir) {
        throw new Error('Invalid pnpm command: -C requires a non-empty directory value.');
      }
      nextCwd = resolvePnpmDirectory(workspaceRoot, nextCwd, rawDir, '-C');
      continue;
    }

    normalizedTokens.push(token);
  }

  if (normalizedTokens.length === 0) {
    throw new Error('Invalid pnpm command: missing executable tokens after pnpm directory flags.');
  }

  return {
    command: normalizedTokens.join(' '),
    cwd: nextCwd,
  };
}

function resolvePnpmDirectory(workspaceRoot: string, currentCwd: string, rawDir: string, flagName: string): string {
  const resolved = isAbsolute(rawDir) ? resolve(rawDir) : resolve(currentCwd, rawDir);
  const rel = relative(workspaceRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Invalid pnpm command: ${flagName} path escapes workspace root: ${rawDir}`);
  }
  return resolved;
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: 'single' | 'double' | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i] ?? '';

    if (char === '\\') {
      const next = command[i + 1];
      if (next !== undefined) {
        current += next;
        i += 1;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === 'single') {
      if (char === "'") {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === 'double') {
      if (char === '"') {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'") {
      quote = 'single';
      continue;
    }

    if (char === '"') {
      quote = 'double';
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error('Invalid shell command: unmatched quote in command.');
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}
