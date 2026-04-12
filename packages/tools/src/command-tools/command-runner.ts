import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommandResult } from '../types.js';

const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
      env: options.env,
    });

    return {
      exitCode: 0,
      stdout,
      stderr,
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return {
        exitCode: -1,
        stdout: '',
        stderr: `${command} not found`,
      };
    }

    const stdout = isRecord(error) && typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = isRecord(error) && typeof error.stderr === 'string'
      ? error.stderr
      : error instanceof Error
        ? error.message
        : String(error);

    const exitCode = isRecord(error) && typeof error.code === 'number' ? error.code : 1;

    return {
      exitCode,
      stdout,
      stderr,
    };
  }
}

export function formatCommandOutput(result: CommandResult, maxChars: number): string {
  const parts = [
    result.stdout.trim(),
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : '',
  ].filter((part) => part.length > 0);

  const combined = parts.join('\n\n');
  if (combined.length <= maxChars) {
    return combined;
  }

  return `${combined.slice(0, maxChars)}\n... (truncated)`;
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}