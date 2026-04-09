import { runCommand } from './command-runner.js';

const RIPGREP_PATH_ERROR_PATTERN = /\bNo such file or directory\b|\bos error 2\b/i;

export interface SafeRipgrepInput {
  cwd: string;
  query: string;
  relTarget: string;
  useRegex: boolean;
  glob?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SafeRipgrepResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  args: string[];
  isPathError: boolean;
}

export function buildSafeRipgrepArgs(input: Pick<SafeRipgrepInput, 'query' | 'relTarget' | 'useRegex' | 'glob'>): string[] {
  const args = ['-n', '--no-heading', '--color', 'never', '-e', input.query];

  if (!input.useRegex) {
    args.push('--fixed-strings');
  }

  if (input.glob) {
    args.push('--glob', input.glob);
  }

  args.push('--', input.relTarget);
  return args;
}

export async function runSafeRipgrep(input: SafeRipgrepInput): Promise<SafeRipgrepResult> {
  const args = buildSafeRipgrepArgs(input);
  const result = await runCommand('rg', args, {
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  return {
    ...result,
    args,
    isPathError: isRipgrepPathError(result.stderr),
  };
}

export function isRipgrepPathError(stderr: string): boolean {
  return RIPGREP_PATH_ERROR_PATTERN.test(stderr.trim());
}

export function mapRipgrepPathError(stderr: string): string {
  if (/No such file or directory/i.test(stderr)) {
    return 'Search failed: ripgrep reported a missing path while scanning. Verify that the provided search path exists in the workspace and that ripgrep is correctly configured.';
  }

  return 'Search failed due to a ripgrep path resolution error (os error 2). Verify search path and ripgrep configuration.';
}