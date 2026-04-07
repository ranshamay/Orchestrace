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

const GITHUB_API_BASE_URL = 'https://api.github.com';
const PLAYWRIGHT_ALLOWED_COMMANDS = new Set([
  'test',
  'show-report',
  'codegen',
  'install',
  'install-deps',
  '--version',
]);
const PLAYWRIGHT_MAX_ARGS = 64;
const DEFAULT_COMMAND_BATCH_CONCURRENCY = 8;
const MAX_COMMAND_BATCH_CONCURRENCY = 64;
const MAX_COMMAND_BATCH_ITEMS = 200;
const DEFAULT_COMMAND_BATCH_MAX_CHARS_PER_COMMAND = 8000;
const DEFAULT_COMMAND_BATCH_MIN_CONCURRENCY = 1;

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
          query: Type.String({ description: 'Search text/pattern passed to ripgrep. Treated as a literal string unless regex=true.' }),
          regex: Type.Optional(Type.Boolean({ description: 'When true, interpret query as regex. Defaults to false (literal search via --fixed-strings).' })),
          path: Type.Optional(Type.String({ description: 'Relative path to search inside. Defaults to workspace root.' })),
          glob: Type.Optional(Type.String({ description: 'Optional glob include filter, e.g. src/**/*.ts' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        const query = asRequiredString(toolArgs.query, 'query');
        const path = asString(toolArgs.path) ?? '.';
        const regex = typeof toolArgs.regex === 'boolean' ? toolArgs.regex : false;
        const glob = asString(toolArgs.glob);
        const target = resolveWorkspacePath(options.cwd, path);
        const relTarget = toWorkspaceRelative(options.cwd, target);

        const args = ['-n', '--no-heading', '--color', 'never'];
        if (!regex) {
          args.push('--fixed-strings');
        }
        args.push(query, relTarget);
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
          intent: Type.Union([
            Type.Literal('read_only'),
            Type.Literal('write'),
          ], { description: 'Declared operation intent. Must be read_only or write.' }),
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
        parameters: Type.Object({
          intent: Type.Union([
            Type.Literal('read_only'),
            Type.Literal('write'),
          ], { description: 'Declared operation intent. Must be read_only or write.' }),
        }),
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
    tools.push(
      {
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
      },
      {
        tool: {
          name: 'run_command_batch',
          description: 'Run multiple shell commands in parallel with the same safety and allowlist guards.',
          parameters: Type.Object({
            commands: Type.Array(
              Type.Object({
                command: Type.String({ description: 'Shell command to execute.' }),
                path: Type.Optional(Type.String({ description: 'Optional relative working directory inside workspace.' })),
              }),
              { minItems: 1, maxItems: MAX_COMMAND_BATCH_ITEMS },
            ),
            concurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_COMMAND_BATCH_CONCURRENCY })),
            adaptiveConcurrency: Type.Optional(Type.Boolean({ description: 'Automatically tune concurrency based on failures while processing the batch.' })),
            minConcurrency: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_COMMAND_BATCH_CONCURRENCY })),
            maxCharsPerCommand: Type.Optional(Type.Number({ minimum: 200, maximum: 20000 })),
          }),
        },
        execute: async (toolArgs, signal) => {
          const commands = asCommandBatchRequests(toolArgs.commands);
          const requestedConcurrency = asPositiveInteger(toolArgs.concurrency)
            ?? options.batchConcurrency
            ?? DEFAULT_COMMAND_BATCH_CONCURRENCY;
          const concurrency = clampConcurrency(requestedConcurrency, MAX_COMMAND_BATCH_CONCURRENCY);
          const adaptiveConcurrency = asBoolean(toolArgs.adaptiveConcurrency)
            ?? options.adaptiveConcurrency
            ?? false;
          const minConcurrency = clampConcurrency(
            asPositiveInteger(toolArgs.minConcurrency)
              ?? options.batchMinConcurrency
              ?? DEFAULT_COMMAND_BATCH_MIN_CONCURRENCY,
            MAX_COMMAND_BATCH_CONCURRENCY,
          );
          const maxCharsPerCommand = asPositiveInteger(toolArgs.maxCharsPerCommand) ?? DEFAULT_COMMAND_BATCH_MAX_CHARS_PER_COMMAND;

          const mapper = async (entry: CommandBatchRequest, index: number) => {
            const cwd = resolveWorkspacePath(options.cwd, entry.path);
            const relativeCwd = toWorkspaceRelative(options.cwd, cwd);

            if (looksDestructive(entry.command)) {
              return {
                index,
                command: entry.command,
                cwd: relativeCwd,
                ok: false,
                blocked: true,
                exitCode: -1,
                output: `Blocked potentially destructive command: ${entry.command}`,
              };
            }

            if (!matchesAllowedPrefix(entry.command, options.runCommandAllowPrefixes)) {
              const allowed = options.runCommandAllowPrefixes?.join(', ') ?? '(none configured)';
              return {
                index,
                command: entry.command,
                cwd: relativeCwd,
                ok: false,
                blocked: true,
                exitCode: -1,
                output: `Blocked command outside allowlist: ${entry.command}\nAllowed prefixes: ${allowed}`,
              };
            }

            const result = await runCommand('zsh', ['-lc', entry.command], {
              cwd,
              timeoutMs: options.commandTimeoutMs ?? 120000,
              signal,
            });

            return {
              index,
              command: entry.command,
              cwd: relativeCwd,
              ok: result.exitCode === 0,
              blocked: false,
              exitCode: result.exitCode,
              output: formatCommandOutput(result, maxCharsPerCommand),
            };
          };

          const batchRun = adaptiveConcurrency
            ? await mapWithAdaptiveConcurrency(commands, {
                initialConcurrency: concurrency,
                minConcurrency,
                maxConcurrency: MAX_COMMAND_BATCH_CONCURRENCY,
              }, mapper, (entry) => !entry.ok)
            : {
                results: await mapWithConcurrency(commands, concurrency, mapper),
                finalConcurrency: concurrency,
                windows: 1,
              };

          const results = batchRun.results;

          const failed = results.filter((entry) => !entry.ok).length;
          return {
            content: JSON.stringify({
              total: results.length,
              concurrency,
              adaptiveConcurrency,
              minConcurrency,
              finalConcurrency: batchRun.finalConcurrency,
              windows: batchRun.windows,
              completed: results.length - failed,
              failed,
              commands: results,
            }, null, 2),
            isError: failed > 0,
          };
        },
      },
      {
        tool: {
          name: 'playwright_run',
          description: 'Run Playwright CLI commands for browser-based verification inside the workspace.',
          parameters: Type.Object({
            command: Type.Optional(Type.String({
              description: 'Playwright subcommand (test, show-report, codegen, install, install-deps, --version). Defaults to test.',
            })),
            args: Type.Optional(Type.Array(
              Type.String({ description: 'Additional args passed to Playwright CLI.' }),
              { maxItems: PLAYWRIGHT_MAX_ARGS },
            )),
            path: Type.Optional(Type.String({ description: 'Optional relative working directory inside workspace.' })),
            timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 900000 })),
          }),
        },
        execute: async (toolArgs, signal) => {
          const command = asString(toolArgs.command) ?? 'test';
          const args = asStringArray(toolArgs.args, 'args') ?? [];
          const path = asString(toolArgs.path) ?? '.';
          const cwd = resolveWorkspacePath(options.cwd, path);
          const relativeCwd = toWorkspaceRelative(options.cwd, cwd);
          const timeoutMs = asPositiveInteger(toolArgs.timeoutMs) ?? Math.max(options.commandTimeoutMs ?? 120000, 180000);

          if (/\s/.test(command)) {
            return {
              content: 'Invalid command. Use the command field for a single Playwright subcommand and pass flags via args.',
              isError: true,
            };
          }

          if (!PLAYWRIGHT_ALLOWED_COMMANDS.has(command)) {
            return {
              content: `Unsupported Playwright command: ${command}. Supported commands: ${[...PLAYWRIGHT_ALLOWED_COMMANDS].join(', ')}`,
              isError: true,
            };
          }

          const runnerCandidates = [
            { binary: 'playwright', prefix: [] as string[], label: 'playwright' },
            { binary: 'pnpm', prefix: ['exec', 'playwright'], label: 'pnpm exec playwright' },
            { binary: 'npx', prefix: ['playwright'], label: 'npx playwright' },
          ];

          let selectedRunner: string | undefined;
          let selectedResult;

          for (const candidate of runnerCandidates) {
            const result = await runCommand(candidate.binary, [...candidate.prefix, command, ...args], {
              cwd,
              timeoutMs,
              signal,
            });

            if (result.exitCode === -1) {
              continue;
            }

            selectedRunner = candidate.label;
            selectedResult = result;
            break;
          }

          if (!selectedResult || !selectedRunner) {
            return {
              content: 'Playwright CLI was not found. Install it in the workspace (for example: pnpm add -D playwright @playwright/test).',
              isError: true,
            };
          }

          const output = formatCommandOutput(selectedResult, options.maxOutputChars ?? 24000);
          return {
            content: `runner: ${selectedRunner}\ncwd: ${relativeCwd}\nexitCode: ${selectedResult.exitCode}\n${output}`,
            isError: selectedResult.exitCode !== 0,
          };
        },
      },
    );
  }

  if (options.resolveGithubToken) {
    tools.push({
      tool: {
        name: 'github_api',
        description: 'Call the GitHub REST or GraphQL API using the authenticated local user token.',
        parameters: Type.Object({
          method: Type.Optional(Type.String({ description: 'HTTP method for REST calls (GET, POST, PATCH, PUT, DELETE).' })),
          path: Type.Optional(Type.String({ description: 'REST API path, e.g. /repos/owner/repo/pulls. Mutually exclusive with graphqlQuery.' })),
          body: Type.Optional(Type.String({ description: 'Optional JSON string body for REST calls.' })),
          graphqlQuery: Type.Optional(Type.String({ description: 'GraphQL query string. Mutually exclusive with path.' })),
          graphqlVariables: Type.Optional(Type.String({ description: 'Optional JSON string object for GraphQL variables.' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        const token = await options.resolveGithubToken?.();
        if (!token) {
          return {
            content: 'GitHub auth is not configured. Connect GitHub in Settings before using github_api.',
            isError: true,
          };
        }

        const path = asString(toolArgs.path);
        const graphqlQuery = asString(toolArgs.graphqlQuery);
        const method = (asString(toolArgs.method) ?? 'GET').trim().toUpperCase();
        const bodyText = asString(toolArgs.body);
        const graphqlVariablesText = asString(toolArgs.graphqlVariables);

        if (!path && !graphqlQuery) {
          return {
            content: 'Missing request target. Provide either path (REST) or graphqlQuery (GraphQL).',
            isError: true,
          };
        }

        if (path && graphqlQuery) {
          return {
            content: 'Invalid request. Provide either path or graphqlQuery, not both.',
            isError: true,
          };
        }

        try {
          const result = graphqlQuery
            ? await callGithubGraphql({
                query: graphqlQuery,
                variablesText: graphqlVariablesText,
                token,
                signal,
              })
            : await callGithubRest({
                path: normalizeGithubPath(path ?? ''),
                method,
                bodyText,
                token,
                signal,
              });

          const content = truncateText(
            JSON.stringify(result, null, 2),
            options.maxOutputChars ?? 24000,
          );

          return {
            content,
            isError: !result.ok,
          };
        } catch (error) {
          return {
            content: `GitHub API request failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
      },
    });
  }

  return tools;
}

async function callGithubRest(params: {
  path: string;
  method: string;
  bodyText?: string;
  token: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { path, method, bodyText, token, signal } = params;
  const body = bodyText ? parseJson(bodyText, 'body') : undefined;

  if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
    throw new Error(`HTTP ${method} request must not include body.`);
  }

  const response = await fetch(`${GITHUB_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  return formatGithubResponse(response);
}

async function callGithubGraphql(params: {
  query: string;
  variablesText?: string;
  token: string;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const { query, variablesText, token, signal } = params;
  const variables = variablesText ? parseJson(variablesText, 'graphqlVariables') : undefined;

  const response = await fetch(`${GITHUB_API_BASE_URL}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      query,
      ...(variables !== undefined ? { variables } : {}),
    }),
    signal,
  });

  return formatGithubResponse(response);
}

function normalizeGithubPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    throw new Error('REST path cannot be empty.');
  }

  if (trimmed.startsWith('https://api.github.com/')) {
    return `/${trimmed.slice('https://api.github.com/'.length)}`;
  }

  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`;
  }

  return trimmed;
}

function parseJson(raw: string, field: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${field}.`);
  }
}

async function formatGithubResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let data: unknown = text;

  if (contentType.includes('application/json') && text.trim().length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data,
    rateLimit: {
      limit: response.headers.get('x-ratelimit-limit') ?? undefined,
      remaining: response.headers.get('x-ratelimit-remaining') ?? undefined,
      reset: response.headers.get('x-ratelimit-reset') ?? undefined,
      resource: response.headers.get('x-ratelimit-resource') ?? undefined,
    },
    scopes: {
      oauth: response.headers.get('x-oauth-scopes') ?? undefined,
      accepted: response.headers.get('x-accepted-oauth-scopes') ?? undefined,
    },
  };
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n... (truncated)`;
}

interface CommandBatchRequest {
  command: string;
  path: string;
}

function asCommandBatchRequests(value: unknown): CommandBatchRequest[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Missing commands');
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Invalid commands[${index}]`);
    }

    return {
      command: asRequiredString(entry.command, `commands[${index}].command`),
      path: asString(entry.path) ?? '.',
    };
  });
}

function clampConcurrency(value: number, max: number): number {
  return Math.max(1, Math.min(max, value));
}

function asPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return undefined;
}

function asStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${field}: expected an array of strings.`);
  }

  return value.map((entry, index) => {
    const parsed = asString(entry);
    if (!parsed) {
      throw new Error(`Invalid ${field}[${index}]: expected a non-empty string.`);
    }

    return parsed;
  });
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (values.length === 0) {
    return [];
  }

  const results = new Array<U>(values.length);
  const workerCount = Math.min(concurrency, values.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
}

async function mapWithAdaptiveConcurrency<T, U>(
  values: readonly T[],
  options: {
    initialConcurrency: number;
    minConcurrency: number;
    maxConcurrency: number;
  },
  mapper: (value: T, index: number) => Promise<U>,
  isFailure: (result: U) => boolean,
): Promise<{ results: U[]; finalConcurrency: number; windows: number }> {
  if (values.length === 0) {
    return { results: [], finalConcurrency: options.initialConcurrency, windows: 0 };
  }

  const results = new Array<U>(values.length);
  let nextIndex = 0;
  let currentConcurrency = clampConcurrency(options.initialConcurrency, options.maxConcurrency);
  const minConcurrency = Math.max(1, Math.min(options.maxConcurrency, options.minConcurrency));
  let windows = 0;

  while (nextIndex < values.length) {
    const start = nextIndex;
    const end = Math.min(values.length, start + currentConcurrency);
    const indexes = [] as number[];
    for (let index = start; index < end; index += 1) {
      indexes.push(index);
    }

    const batchResults = await Promise.all(indexes.map(async (index) => mapper(values[index], index)));
    for (let offset = 0; offset < batchResults.length; offset += 1) {
      results[indexes[offset]] = batchResults[offset];
    }

    windows += 1;
    const failures = batchResults.reduce((count, result) => (isFailure(result) ? count + 1 : count), 0);
    currentConcurrency = failures === 0
      ? Math.min(options.maxConcurrency, currentConcurrency * 2)
      : Math.max(minConcurrency, Math.floor(currentConcurrency / 2));
    nextIndex = end;
  }

  return {
    results,
    finalConcurrency: currentConcurrency,
    windows,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}