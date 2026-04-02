import { Type } from '@mariozechner/pi-ai';
import type { AgentToolsetOptions, RegisteredAgentTool } from './types.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './path-utils.js';
import { formatCommandOutput, runCommand } from './command-tools/command-runner.js';
import {
  asRequiredString,
  asString,
  looksDestructive,
  matchesAllowedPrefix,
} from './command-tools/guards.js';

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
          return { content: '(no matches)' };
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
    {
      tool: {
        name: 'git_status',
        description: 'Show concise git working tree status for the workspace.',
        parameters: Type.Object({}),
      },
      execute: async (_toolArgs, signal) => {
        const result = await runCommand('git', ['status', '--short', '--branch'], {
          cwd: options.cwd,
          timeoutMs: options.commandTimeoutMs ?? 20000,
          signal,
        });

        const output = formatCommandOutput(result, options.maxOutputChars ?? 12000);
        return {
          content: output.length > 0 ? output : '(clean working tree)',
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