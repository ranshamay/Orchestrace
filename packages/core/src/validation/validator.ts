import type { TaskOutput, ValidationConfig, ValidationResult } from '../dag/types.js';
import { exec } from 'node:child_process';

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
      } catch (err) {
        // Flake detection: retry once before reporting failure
        const retryStart = Date.now();
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

function runCommand(command: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} failed:\n${stderr || stdout || error.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
