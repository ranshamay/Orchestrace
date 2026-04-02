import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from '@mariozechner/pi-ai';
import type { AgentToolsetOptions, CommandResult, RegisteredAgentTool } from './types.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './path-utils.js';

const execFileAsync = promisify(execFile);

interface CommandToolOptions extends AgentToolsetOptions {
  includeRunCommandTool: boolean;
  runCommandAllowPrefixes?: string[];
}

export function createCommandTools(options: CommandToolOptions): RegisteredAgentTool[] {
  const tools: RegisteredAgentTool[] = [
    {
      tool: {
        name: 'search_files',
        description: 'Search file contents using ripgrep within the workspace.',
        parameters: Type.Object({
          query: Type.String({ description: 'Regex or plain-text search pattern passed to ripgrep.' }),
          path: Type.Optional(Type.String({ description: 'Relative path to search inside. Defaults to workspace root.' })),
          glob: Type.Optional(Type.String({ description: 'Optional glob include filter, e.g. src/**/*.ts' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        const query = asRequiredString(toolArgs.query, 'query');
        const path = asString(toolArgs.path) ?? '.';
        const glob = asString(toolArgs.glob);
        const target = resolveWorkspacePath(options.cwd, path);
        const relTarget = toWorkspaceRelative(options.cwd, target);

        const args = ['-n', '--no-heading', '--color', 'never', query, relTarget];
        if (glob) {
          args.push('--glob', glob);
        }

        const result = await runCommand('rg', args, {
          cwd: options.cwd,
          timeoutMs: options.commandTimeoutMs ?? 20000,
          signal,
        });

        if (result.exitCode === -1) {
          return {
            content: 'ripgrep (rg) is required but was not found in PATH.',
            isError: true,
          };
        }

        if (result.exitCode === 1 && result.stdout.trim().length === 0) {
          return {
            content: '(no matches)',
          };
        }

        const output = formatCommandOutput(result, options.maxOutputChars ?? 16000);
        return {
          content: output,
          isError: result.exitCode > 1,
        };
      },
    },
    {
      tool: {
        name: 'git_diff',
        description: 'Show git diff for current workspace changes.',
        parameters: Type.Object({
          staged: Type.Optional(Type.Boolean({ description: 'Show staged diff instead of unstaged.' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        const staged = Boolean(toolArgs.staged);
        const args = staged ? ['diff', '--staged'] : ['diff'];

        const result = await runCommand('git', args, {
          cwd: options.cwd,
          timeoutMs: options.commandTimeoutMs ?? 20000,
          signal,
        });

        const output = formatCommandOutput(result, options.maxOutputChars ?? 20000);
        return {
          content: output.length > 0 ? output : '(no diff)',
          isError: result.exitCode !== 0,
        };
      },
    },
  ];

  if (options.includeRunCommandTool) {
    tools.push({
      tool: {
        name: 'run_command',
        description: 'Run a shell command in the workspace and return stdout/stderr.',
        parameters: Type.Object({
          command: Type.String({ description: 'Shell command to execute.' }),
          path: Type.Optional(Type.String({ description: 'Optional relative working directory inside workspace.' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        const command = asRequiredString(toolArgs.command, 'command');
        const path = asString(toolArgs.path) ?? '.';
        const cwd = resolveWorkspacePath(options.cwd, path);

        if (looksDestructive(command)) {
          return {
            content: `Blocked potentially destructive command: ${command}`,
            isError: true,
          };
        }

        if (!matchesAllowedPrefix(command, options.runCommandAllowPrefixes)) {
          const allowed = options.runCommandAllowPrefixes?.join(', ') ?? '(none configured)';
          return {
            content: `Blocked command outside allowlist: ${command}\nAllowed prefixes: ${allowed}`,
            isError: true,
          };
        }

        const result = await runCommand('zsh', ['-lc', command], {
          cwd,
          timeoutMs: options.commandTimeoutMs ?? 120000,
          signal,
        });

        const output = formatCommandOutput(result, options.maxOutputChars ?? 24000);
        const header = `cwd: ${toWorkspaceRelative(options.cwd, cwd)}\nexitCode: ${result.exitCode}`;

        return {
          content: `${header}\n${output}`,
          isError: result.exitCode !== 0,
        };
      },
    });
  }

  return tools;
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      signal: options.signal,
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

function formatCommandOutput(result: CommandResult, maxChars: number): string {
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

function asString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRequiredString(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) {
    throw new Error(`Missing ${field}`);
  }

  return parsed;
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === 'object' && value !== null && 'code' in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function matchesAllowedPrefix(command: string, prefixes?: string[]): boolean {
  if (!prefixes || prefixes.length === 0) {
    return true;
  }

  const normalized = command.trim().toLowerCase();
  return prefixes.some((prefix) => normalized.startsWith(prefix.trim().toLowerCase()));
}

function looksDestructive(command: string): boolean {
  const normalized = command.toLowerCase();
  const blockedPatterns = [
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fdx\b/,
    /\brm\s+-rf\s+\/$/,
    /\bsudo\b/,
  ];

  return blockedPatterns.some((pattern) => pattern.test(normalized));
}