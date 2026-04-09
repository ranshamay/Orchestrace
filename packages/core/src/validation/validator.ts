import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { TaskOutput, ValidationConfig, ValidationResult } from '../dag/types.js';
import { parseShellCommandToArgv } from './shell-command-parser.js';

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

function runCommand(command: string, cwd: string): Promise<string> {
  const parsed = parseShellCommandToArgv(command);
  if (!parsed.ok || !parsed.parsed) {
    throw new Error(`${command} failed:\n${parsed.reason ?? 'unable to parse command safely'}`);
  }

  const { program, args } = parsed.parsed;

  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${command} failed:\n${stderr || stdout || error.message}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
