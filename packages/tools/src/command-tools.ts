import { constants } from 'node:fs';
import { access, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join } from 'node:path';
import { Type } from '@mariozechner/pi-ai';
import type { AgentToolsetOptions, CommandResult, RegisteredAgentTool } from './types.js';
import { resolveWorkspacePath, toWorkspaceRelative } from './path-utils.js';
import { formatCommandOutput, runCommand } from './command-tools/command-runner.js';
import {
  asRequiredString,
  asString,
  looksDestructive,
  matchesAllowedPrefix,
  validateShellCommandPayload,
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

function resolveShellExecutable(): string {
  const envShell = process.env.SHELL?.trim();
  return envShell && envShell.length > 0 ? envShell : 'sh';
}

interface CommandToolOptions extends AgentToolsetOptions {
  includeRunCommandTool: boolean;
  runCommandAllowPrefixes?: string[];
}

interface SearchFilesErrorDetails {
  errorType:
    | 'invalid_arguments'
    | 'invalid_working_directory'
    | 'missing_dependency'
    | 'invalid_regex'
    | 'filesystem_fallback_failed'
    | 'command_failed';
  message: string;
  toolName: 'search_files';
  stderr?: string;
  exitCode?: number;
  command?: string;
  path?: string;
}


export function createCommandTools(options: CommandToolOptions): RegisteredAgentTool[] {
  const shellExecutable = resolveShellExecutable();
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
          queryMode: Type.Optional(Type.Union([
            Type.Literal('regex'),
            Type.Literal('literal'),
          ], {
            description: 'How to interpret query: regex (default) or literal fixed-string search.',
          })),
        }),
      },
            execute: async (toolArgs, signal) => {
        const requestedPath = asString(toolArgs.path) ?? '.';
        const sanitizedQueryAndMode = sanitizeSearchQueryAndMode({
          query: toolArgs.query,
          queryMode: asString(toolArgs.queryMode),
          regex: typeof toolArgs.regex === 'boolean' ? toolArgs.regex : undefined,
        });
        if (!sanitizedQueryAndMode.ok) {
          return createSearchFilesErrorResult({
            errorType: 'invalid_arguments',
            message: sanitizedQueryAndMode.error,
            path: requestedPath,
          });
        }

        const { query, useRegex } = sanitizedQueryAndMode.value;

        if (useRegex) {
          const regexValidation = validateRegexQuery(query);
          if (!regexValidation.ok) {
            return createSearchFilesErrorResult({
              errorType: 'invalid_regex',
              message: regexValidation.error,
              path: requestedPath,
            });
          }
        }

        const globValidation = validateSearchGlob(toolArgs.glob);
        if (!globValidation.ok) {
          return createSearchFilesErrorResult({
            errorType: 'invalid_arguments',
            message: globValidation.error,
            path: requestedPath,
          });
        }

        const resolvedCwd = await normalizeSearchCwd(options.cwd);
        if (!resolvedCwd.ok) {
          return createSearchFilesErrorResult({
            errorType: 'invalid_working_directory',
            message: `Invalid working directory for search_files: ${resolvedCwd.cwd}`,
            path: requestedPath,
          });
        }

        const normalizedRequestedPath = await normalizeRequestedSearchPath(requestedPath);
        const normalizedPathForResolution = isAbsolute(normalizedRequestedPath)
          ? (await canonicalizeExistingPath(normalizedRequestedPath)) ?? normalizedRequestedPath
          : normalizedRequestedPath;

        let target: string;
                try {
          target = resolveWorkspacePath(resolvedCwd.cwd, normalizedPathForResolution);
        } catch {
          return {
            content: `(skipped invalid search path: ${normalizedRequestedPath.replace(/\\/g, '/')})`,
            isError: false,
          };
        }


        const canonicalTarget = await canonicalizeExistingPath(target);
        const relTarget = toWorkspaceRelative(resolvedCwd.cwd, canonicalTarget ?? target).replace(/\\/g, '/');
        const targetKind = await getPathKind(canonicalTarget ?? target);

                if (targetKind === 'missing') {
          return {
            content: `(skipped invalid search path: ${relTarget})`,
            isError: false,
          };
        }


        if (globValidation.value && targetKind === 'file') {
          return createSearchFilesErrorResult({
            errorType: 'invalid_arguments',
            message: 'Invalid glob usage: glob can only be used when path points to a directory.',
            path: relTarget,
          });
        }

        // Re-check right before spawning rg to avoid deterministic path-miss noise
        // when a target is removed between earlier normalization and command execution.
        const targetKindBeforeSearch = await getPathKind(canonicalTarget ?? target);
                if (targetKindBeforeSearch === 'missing') {
          return {
            content: `(skipped invalid search path: ${relTarget})`,
            isError: false,
          };
        }


        const args = ['-n', '--no-heading', '--color', 'never', '-e', query];
        if (!useRegex) {
          args.push('--fixed-strings');
        }
        if (globValidation.value) {
          args.push('--glob', globValidation.value);
        }
        args.push('--', relTarget);

        const result = await runCommand('rg', args, {
          cwd: resolvedCwd.cwd,
          timeoutMs: options.commandTimeoutMs ?? 20000,
          signal,
        });

        const stderr = result.stderr.trim();

        if (result.exitCode === -1) {
          try {
            const fallback = await fallbackSearchFromFs({
              cwd: resolvedCwd.cwd,
              target: canonicalTarget ?? target,
              relTarget,
              query,
              useRegex,
              glob: globValidation.value,
              maxChars: options.maxOutputChars ?? 16000,
            });
                        return {
              content: fallback,
              isError: false,
            };

          } catch (error) {
                        if (isMissingPathErrorLike(error)) {
              return {
                content: `(skipped invalid search path: ${relTarget})`,
                isError: false,
              };
            }


            return createSearchFilesErrorResult({
              errorType: 'filesystem_fallback_failed',
              message: error instanceof Error ? error.message : String(error),
              stderr,
              exitCode: result.exitCode,
              command: 'rg',
              path: relTarget,
            });
          }
        }

                        const output = formatCommandOutput(result, options.maxOutputChars ?? 16000);
        const hasMatches = result.stdout.trim().length > 0;

        // Prefer successful match output when available. ripgrep may emit stderr
        // diagnostics in mixed-result scenarios; only escalate error behavior
        // when there are no matches to return.
        if (hasMatches) {
          return {
            content: formatSuccessfulSearchOutput(result, options.maxOutputChars ?? 16000),
            isError: false,
          };
        }


        if (result.exitCode === 2 && useRegex) {
          return createSearchFilesErrorResult({
            errorType: 'invalid_regex',
            message: 'Invalid regex query.',
            stderr,
            exitCode: result.exitCode,
            command: 'rg',
            path: relTarget,
          });
        }

        const hasPathError = hasRipgrepPathError(stderr);


                if (result.exitCode === 1 && result.stdout.trim().length === 0) {
          return { content: '(no matches)', isError: false };
        }

        if (hasPathError) {
          const targetKindAfterSearch = await getPathKind(canonicalTarget ?? target);
                    if (targetKindAfterSearch === 'missing') {
            return {
              content: `(skipped invalid search path: ${relTarget})`,
              isError: false,
            };
          }


          try {
            const fallback = await fallbackSearchFromFs({
              cwd: resolvedCwd.cwd,
              target: canonicalTarget ?? target,
              relTarget,
              query,
              useRegex,
              glob: globValidation.value,
              maxChars: options.maxOutputChars ?? 16000,
            });
                        return {
              content: fallback,
              isError: false,
            };

          } catch (error) {
                        if (isMissingPathErrorLike(error)) {
              return {
                content: `(skipped invalid search path: ${relTarget})`,
                isError: false,
              };
            }


            return createSearchFilesErrorResult({
              errorType: 'filesystem_fallback_failed',
              message: error instanceof Error ? error.message : String(error),
              stderr,
              exitCode: result.exitCode,
              command: 'rg',
              path: relTarget,
            });
          }
        }
        if (result.exitCode > 1) {
          return createSearchFilesErrorResult({
            errorType: 'command_failed',
            message: output,
            stderr,
            exitCode: result.exitCode,
            command: 'rg',
            path: relTarget,
          });
        }

        return {
          content: output,
          isError: false,
        };
      },

    },
    {
      tool: {
        name: 'git_diff',
        description: 'Show git diff for current workspace changes.',
        parameters: Type.Object({
          intent: Type.String({
            enum: ['read_only', 'write'],
            description: 'Declare whether the task is read-only or write-oriented before checking repository state.',
          }),
          staged: Type.Optional(Type.Boolean({ description: 'Show staged diff instead of unstaged.' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        asRequiredString(toolArgs.intent, 'intent');
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
          intent: Type.String({
            enum: ['read_only', 'write'],
            description: 'Declare whether the task is read-only or write-oriented before checking repository state.',
          }),
        }),
      },
      execute: async (toolArgs, signal) => {
        asRequiredString(toolArgs.intent, 'intent');
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
    {
      tool: {
        name: 'url_fetch',
        description: 'Fetch a URL over HTTP(S) and return status, headers, and response body.',
        parameters: Type.Object({
          url: Type.String({ description: 'Absolute HTTP(S) URL to fetch.' }),
          method: Type.Optional(Type.String({ description: 'HTTP method to use. Defaults to GET.' })),
          headers: Type.Optional(Type.String({ description: 'Optional JSON string object of request headers.' })),
          body: Type.Optional(Type.String({ description: 'Optional request body as text. Not allowed for GET/HEAD.' })),
        }),
      },
      execute: async (toolArgs, signal) => {
        const url = normalizeHttpUrl(asRequiredString(toolArgs.url, 'url'));
        const method = (asString(toolArgs.method) ?? 'GET').trim().toUpperCase();
        const headersText = asString(toolArgs.headers);
        const body = asString(toolArgs.body);

        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method)) {
          return {
            content: `Unsupported HTTP method: ${method}`,
            isError: true,
          };
        }

        if ((method === 'GET' || method === 'HEAD') && body !== undefined) {
          return {
            content: `HTTP ${method} request must not include body.`,
            isError: true,
          };
        }

        let headers: Record<string, string> | undefined;
        try {
          headers = headersText ? parseStringRecord(headersText, 'headers') : undefined;
        } catch (error) {
          return {
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          };
        }

        try {
          const response = await fetch(url, {
            method,
            headers,
            body,
            signal,
          });

          const text = await response.text();
          const contentType = response.headers.get('content-type') ?? '';
          const data = parseBodyByContentType(text, contentType);
          const content = truncateText(JSON.stringify({
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            url: response.url,
            method,
            contentType,
            headers: Object.fromEntries(response.headers.entries()),
            data,
          }, null, 2), options.maxOutputChars ?? 24000);

          return {
            content,
            isError: !response.ok,
          };
        } catch (error) {
          return {
            content: `URL fetch failed: ${error instanceof Error ? error.message : String(error)}`,
            isError: true,
          };
        }
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

          const payloadValidation = validateShellCommandPayload(command);
          if (!payloadValidation.ok) {
            return {
              content: `${payloadValidation.reason ?? 'Blocked non-command payload.'} Payload: ${command}`,
              isError: true,
            };
          }

          const result = await runCommand(shellExecutable, ['-lc', command], {
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

            const payloadValidation = validateShellCommandPayload(entry.command);
            if (!payloadValidation.ok) {
              return {
                index,
                command: entry.command,
                cwd: relativeCwd,
                ok: false,
                blocked: true,
                exitCode: -1,
                output: `${payloadValidation.reason ?? 'Blocked non-command payload.'} Payload: ${entry.command}`,
              };
            }

            const result = await runCommand(shellExecutable, ['-lc', entry.command], {
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

type PathKind = 'missing' | 'file' | 'directory';

async function normalizeSearchCwd(cwd: string): Promise<{ ok: true; cwd: string } | { ok: false; cwd: string }> {
  const trimmed = cwd.trim();
  if (!trimmed) {
    return { ok: false, cwd };
  }

  try {
    const normalized = await realpath(trimmed);
    await access(normalized, constants.R_OK | constants.X_OK);
    return { ok: true, cwd: normalized };
  } catch {
    return { ok: false, cwd: trimmed };
  }
}

function createSearchFilesErrorResult(details: Omit<SearchFilesErrorDetails, 'toolName'>): { content: string; isError: true; details: SearchFilesErrorDetails } {
  return {
    content: details.message,
    isError: true,
    details: {
      ...details,
      toolName: 'search_files',
    },
  };
}

async function canonicalizeExistingPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}


async function getPathKind(path: string): Promise<PathKind> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) {
      return 'directory';
    }
    if (info.isFile()) {
      return 'file';
    }
    return 'missing';
  } catch {
    return 'missing';
  }
}

type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

interface SanitizedSearchQueryAndModeInput {
  query: unknown;
  queryMode: string | undefined;
  regex: boolean | undefined;
}

function sanitizeSearchQueryAndMode(input: SanitizedSearchQueryAndModeInput): ValidationResult<{ query: string; useRegex: boolean }> {
  const queryValidation = validateSearchQuery(input.query);
  if (!queryValidation.ok) {
    return queryValidation;
  }

  const queryModeValidation = validateQueryMode(input.queryMode);
  if (!queryModeValidation.ok) {
    return queryModeValidation;
  }

  const resolvedMode = resolveSearchQueryMode({
    queryMode: queryModeValidation.value,
    regex: input.regex,
  });

  return {
    ok: true,
    value: {
      query: queryValidation.value,
      useRegex: resolvedMode === 'regex',
    },
  };
}

function resolveSearchQueryMode(input: {
  queryMode: 'regex' | 'literal' | undefined;
  regex: boolean | undefined;
}): 'regex' | 'literal' {
  if (input.queryMode !== undefined) {
    return input.queryMode;
  }

  if (input.regex === true) {
    return 'regex';
  }

  return 'literal';
}




function validateSearchQuery(rawQuery: unknown): ValidationResult<string> {

  if (typeof rawQuery !== 'string') {
    return {
      ok: false,
      error: 'Missing query',
    };
  }

  const trimmedQuery = rawQuery.trim();
  if (trimmedQuery.length === 0) {
    return {
      ok: false,
      error: 'Invalid query: query must not be empty.',
    };
  }

  if (trimmedQuery.includes('\u0000')) {
    return {
      ok: false,
      error: 'Invalid query: null bytes are not allowed.',
    };
  }

  if (/[\r\n]/.test(trimmedQuery)) {
    return {
      ok: false,
      error: 'Invalid query: query must be a single-line string.',
    };
  }

  if (hasUnsupportedSearchControlChars(trimmedQuery)) {
    return {
      ok: false,
      error: 'Invalid query: control characters are not allowed.',
    };
  }

  if (looksLikeRipgrepPathSpecFragment(trimmedQuery)) {
    return {
      ok: false,
      error: 'Invalid query: query appears to be a ripgrep path/filter fragment. Provide search text in query and file scope in path/glob.',
    };
  }

  return { ok: true, value: trimmedQuery };
}

function hasUnsupportedSearchControlChars(query: string): boolean {
  return /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(query);
}

function looksLikeRipgrepPathSpecFragment(query: string): boolean {
  const normalized = query.trim();
  if (normalized.length === 0) {
    return false;
  }

  if (/\s--\s/.test(` ${normalized} `)) {
    return true;
  }

  const tokens = normalized.split(/\s+/);
  const first = (tokens[0] ?? '').toLowerCase();

  if (
    first === '--'
    || first === '-g'
    || first === '--glob'
    || first.startsWith('--glob=')
    || first === '--iglob'
    || first.startsWith('--iglob=')
    || first === '-t'
    || first === '--type'
    || first.startsWith('--type=')
    || first === '-T'
    || first === '--type-not'
    || first.startsWith('--type-not=')
  ) {
    return true;
  }

  return false;
}


function validateQueryMode(rawMode: string | undefined): ValidationResult<'regex' | 'literal' | undefined> {
  if (rawMode === undefined) {
    return { ok: true, value: undefined };
  }

  if (rawMode !== 'regex' && rawMode !== 'literal') {
    return {
      ok: false,
      error: "Invalid queryMode. Expected 'regex' or 'literal'.",
    };
  }

  return { ok: true, value: rawMode };
}

// Intentionally no regex auto-repair helpers: invalid regex input should remain deterministic.



function isValidRegexQuery(query: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(query);
    return true;
  } catch {
    return false;
  }
}

function validateRegexQuery(query: string): ValidationResult<string> {
  if (isValidRegexQuery(query)) {
    return { ok: true, value: query };
  }

  return {
    ok: false,
    error: 'Invalid regex query.',
  };
}


function validateSearchGlob(rawGlob: unknown): ValidationResult<string | undefined> {
  if (rawGlob === undefined) {
    return { ok: true, value: undefined };
  }

  if (typeof rawGlob !== 'string') {
    return {
      ok: false,
      error: 'Invalid glob: expected a string value.',
    };
  }

  const glob = rawGlob.trim();
  if (glob.length === 0) {
    return {
      ok: false,
      error: 'Invalid glob: expected a non-empty string when provided.',
    };
  }

  if (glob.includes('\u0000')) {
    return {
      ok: false,
      error: 'Invalid glob: null bytes are not allowed.',
    };
  }

  return { ok: true, value: glob.replace(/\\/g, '/') };
}

async function normalizeRequestedSearchPath(rawPath: string): Promise<string> {
  const trimmed = rawPath.trim();
  if (trimmed.length === 0) {
    return '.';
  }

  if (trimmed.includes('\u0000')) {
    throw new Error('Invalid search path: null bytes are not allowed.');
  }

    return trimmed;
}

function hasRipgrepPathError(stderr: string): boolean {
  return isDeterministicRipgrepPathError(stderr);
}

function formatSuccessfulSearchOutput(result: CommandResult, maxChars: number): string {
  const sanitizedStderr = removeRipgrepPathErrorLines(result.stderr);
  return formatCommandOutput({
    ...result,
    stderr: sanitizedStderr,
  }, maxChars);
}

function removeRipgrepPathErrorLines(stderr: string): string {
  if (stderr.trim().length === 0) {
    return stderr;
  }

  const lines = stderr
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !isDeterministicRipgrepPathError(line));

  return lines.join('\n');
}

function isDeterministicRipgrepPathError(stderr: string): boolean {
  const normalized = stderr.trim();
  if (normalized.length === 0) {
    return false;
  }

  return /\bNo such file or directory\b|\bos error 2\b|\bENOENT\b/i.test(normalized);
}


function isMissingPathErrorLike(error: unknown): boolean {
  if (!error) {
    return false;
  }

  if (typeof error === 'object' && error !== null) {
    const code = Reflect.get(error, 'code');
    if (code === 'ENOENT') {
      return true;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return /\bNo such file or directory\b|\bos error 2\b|\bENOENT\b/i.test(message);
}

interface FallbackSearchInput {

  cwd: string;
  target: string;
  relTarget: string;
  query: string;
  useRegex: boolean;
  glob?: string;
  maxChars: number;
}

async function fallbackSearchFromFs(input: FallbackSearchInput): Promise<string> {
  const files = await collectSearchCandidateFiles(input.target, input.glob);
  if (files.length === 0) {
    return `(skipped invalid search path: ${input.relTarget})`;
  }

  const lines: string[] = [];
  const matcher = createLineMatcher(input.query, input.useRegex);

    for (const filePath of files) {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (error) {
      if (isMissingPathErrorLike(error)) {
        continue;
      }
      throw error;
    }

    const rows = content.split(/\r?\n/);
    for (let i = 0; i < rows.length; i += 1) {
      const line = rows[i] ?? '';
      if (matcher(line)) {
        const relFile = toWorkspaceRelative(input.cwd, filePath).replace(/\\/g, '/');
        lines.push(`${relFile}:${i + 1}:${line}`);
      }
    }
  }


  if (lines.length === 0) {
    return '(no matches)';
  }

  return truncateText(lines.join('\n'), input.maxChars);
}

function createLineMatcher(query: string, useRegex: boolean): (line: string) => boolean {
  if (!useRegex) {
    return (line) => line.includes(query);
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(query);
  } catch {
    throw new Error('Invalid regex query.');
  }

  return (line) => pattern.test(line);
}

async function collectSearchCandidateFiles(target: string, glob: string | undefined): Promise<string[]> {
  const kind = await getPathKind(target);
  if (kind === 'missing') {
    return [];
  }

  if (kind === 'file') {
    if (!glob || matchesSimpleGlob(target, glob)) {
      return [target];
    }
    return [];
  }

  const files: string[] = [];
  const stack = [target];

    while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathErrorLike(error)) {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        if (!glob || matchesSimpleGlob(fullPath, glob)) {
          files.push(fullPath);
        }
      }
    }
  }


  files.sort((a, b) => a.localeCompare(b));
  return files;
}

function matchesSimpleGlob(filePath: string, glob: string): boolean {
  const normalizedGlob = glob.trim().toLowerCase();
  if (normalizedGlob.length === 0) {
    return true;
  }

  if (normalizedGlob.startsWith('*.') && !normalizedGlob.includes('/')) {
    return extname(filePath).toLowerCase() === normalizedGlob.slice(1);
  }

  if (!normalizedGlob.includes('*')) {
    return filePath.replace(/\\/g, '/').toLowerCase().includes(normalizedGlob.replace(/\\/g, '/'));
  }

  return true;
}

function parseStringRecord(raw: string, field: string): Record<string, string> {
  const parsed = parseJson(raw, field);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid ${field}: expected a JSON object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(`Invalid ${field}.${key}: expected a string value.`);
    }
    result[key] = value;
  }

  return result;
}

function normalizeHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid url: expected an absolute HTTP(S) URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid url: only http:// and https:// are supported.');
  }

  return parsed.toString();
}

function parseBodyByContentType(text: string, contentType: string): unknown {
  if (!text) {
    return '';
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
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