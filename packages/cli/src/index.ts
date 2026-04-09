import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { orchestrate, type TaskRouteCategory } from '@orchestrace/core';
import type { TaskGraph, DagEvent, PlanApprovalRequest, TaskOutput } from '@orchestrace/core';
import { PiAiAdapter, ProviderAuthManager } from '@orchestrace/provider';
import type { ProviderInfo } from '@orchestrace/provider';
import { DEFAULT_AGENT_TOOL_POLICY_VERSION, createAgentToolset } from '@orchestrace/tools';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { startUiServer } from './ui-server.js';
import { enforceSafeShellDispatch, resolveTaskRoute, validateShellInput } from './task-routing.js';
import { WorkspaceManager } from './workspace-manager.js';
import type { WorkspaceEntry } from './workspace-manager.js';
import { parseAndSanitizeVerifyCommands } from './verify-commands.js';

const SUB_AGENT_READ_ONLY_TOOL_ALLOWLIST = [
  'list_directory',
  'read_file',
  'search_files',
  'git_diff',
  'git_status',
  'url_fetch',
];

const GITHUB_PROVIDER_ID = 'github';

function createReadOnlySubAgentToolset(cwd: string, taskRequiresWrites?: boolean) {
  return createAgentToolset({
    cwd,
    phase: 'planning',
    taskRequiresWrites,
    permissions: {
      allowWriteTools: false,
      allowRunCommand: false,
      toolAllowlist: [...SUB_AGENT_READ_ONLY_TOOL_ALLOWLIST],
    },
  });
}

function createGithubAuthManager(): ProviderAuthManager {
  return new ProviderAuthManager({
    authFilePath: resolve(homedir(), '.orchestrace', 'github-auth.json'),
  });
}

interface ReplayRunTaskSummary {
  taskId: string;
  status: string;
  file: string;
}

interface ReplayRunIndex {
  version: number;
  createdAt?: string;
  runId: string;
  graphId?: string;
  graphName?: string;
  taskCount?: number;
  tasks: ReplayRunTaskSummary[];
}

interface ReplayTaskAttempt {
  phase: 'planning' | 'implementation';
  attempt: number;
  startedAt: string;
  completedAt: string;
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
  stopReason?: string;
  endpoint?: string;
  usage?: { input: number; output: number; cost: number };
  textPreview?: string;
  error?: string;
  failureType?: string;
  toolCalls?: Array<{
    time: string;
    toolCallId: string;
    toolName: string;
    status: 'started' | 'result';
    input?: string;
    output?: string;
    isError?: boolean;
  }>;
  validation?: {
    passed: boolean;
    commandResults: Array<{
      command: string;
      passed: boolean;
      output: string;
      durationMs: number;
    }>;
  };
}

interface ReplayTaskArtifact {
  version: number;
  createdAt?: string;
  runId: string;
  graphId: string;
  graphName?: string;
  taskId: string;
  taskName?: string;
  taskType?: string;
  status: 'completed' | 'failed';
  durationMs: number;
  retries: number;
  failureType?: string;
  usage?: { input: number; output: number; cost: number };
  error?: string;
  responsePreview?: string;
  replay?: {
    version: number;
    promptVersion: string;
    policyVersion: string;
    provider: string;
    model: string;
    reasoning?: 'minimal' | 'low' | 'medium' | 'high';
    attempts: ReplayTaskAttempt[];
  };
}

const execFileAsync = promisify(execFile);
loadDotEnv({ quiet: true });

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
orchestrace — DAG-based agent orchestration

Usage:
  orchestrace run <plan.json>   Execute a task graph from a JSON plan file
  orchestrace task <prompt>     Run a single prompt task with automatic routing (shell/investigation/code)
  orchestrace replay list [--limit 20]   List persisted replay runs
  orchestrace replay show <runId> [--task <taskId>]  Show persisted replay artifacts
  orchestrace workspace         Manage registered workspaces and active workspace
  orchestrace ui [--port 4310]  Start local dashboard for status, auth, and controls
  orchestrace auth              Interactive provider selection + authentication
  orchestrace auth status       Show auth status for providers
  orchestrace --help            Show this help

Flags:
  --provider <id>               Provider override (e.g. github-copilot, anthropic)
  --model <id>                  Model override for the selected provider
  --workspace <id|name|path>    Workspace to run against (and set active)
  --port <number>               Port for UI server (default 4310)
  --hmr                         Enable UI hot reload (default: enabled)
  --no-hmr                      Disable UI hot reload
  --auto-approve                Skip manual plan approval gate
  --push                        Commit and push if execution succeeds
  --commit-message <message>    Commit message when --push is enabled

Plan file format:
  {
    "id": "my-plan",
    "name": "Feature implementation",
    "nodes": [
      {
        "id": "plan",
        "name": "Create implementation plan",
        "type": "plan",
        "prompt": "Analyze the codebase and create a plan for...",
        "dependencies": [],
        "model": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "reasoning": "high" }
      },
      {
        "id": "implement",
        "name": "Implement the feature",
        "type": "code",
        "prompt": "Implement the feature based on the plan...",
        "dependencies": ["plan"],
        "validation": {
          "commands": ["pnpm tsc --noEmit", "pnpm vitest run"],
          "maxRetries": 2,
          "retryDelayMs": 2000
        }
      }
    ]
  }

Environment variables:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, etc. (optional fallback)
  auth.json is preferred and managed by 'orchestrace auth'
  ORCHESTRACE_DEFAULT_PROVIDER   Default LLM provider (default: anthropic)
  ORCHESTRACE_DEFAULT_MODEL      Default model ID
  ORCHESTRACE_WORKSPACE          Active workspace identifier/path override
  ORCHESTRACE_UI_HMR             true/false UI hot reload
  ORCHESTRACE_LLM_TIMEOUT_MS     Per-request LLM timeout in milliseconds (default: 120000)
  ORCHESTRACE_LLM_LONG_TURN_TIMEOUT_MS  Planning/delegation timeout override (default: 300000)
  ORCHESTRACE_LLM_PLANNING_TIMEOUT_MS   Planning timeout override (default: long-turn timeout)
  ORCHESTRACE_LLM_DELEGATION_TIMEOUT_MS Delegation timeout override (default: long-turn timeout)
  ORCHESTRACE_SUBAGENT_TIMEOUT_MS       Sub-agent timeout override (default: delegation timeout)
  ORCHESTRACE_MAX_PARALLEL       Max concurrent tasks (default: 4)
  ORCHESTRACE_AUTO_APPROVE       true/false plan auto-approval
  ORCHESTRACE_AUTO_PUSH          true/false auto git commit + push
  ORCHESTRACE_PROMPT_VERSION     Replay prompt-version override
  ORCHESTRACE_POLICY_VERSION     Replay policy-version override
  ORCHESTRACE_VERIFY_COMMANDS    Semicolon-separated validation commands
`);
    process.exit(0);
  }

  const command = args[0];

  const flagArgs = args.slice(1);
  const autoApprove = getBooleanFlag(flagArgs, '--auto-approve', process.env.ORCHESTRACE_AUTO_APPROVE === 'true');
  const autoPush = getBooleanFlag(flagArgs, '--push', process.env.ORCHESTRACE_AUTO_PUSH === 'true');
  const providerOverride = getFlagValue(flagArgs, '--provider');
  const modelOverride = getFlagValue(flagArgs, '--model');
  const workspaceOverride = getFlagValue(flagArgs, '--workspace') ?? process.env.ORCHESTRACE_WORKSPACE;
  const portOverride = parseInt(getFlagValue(flagArgs, '--port') ?? '', 10);
  const uiHmr = getUiHmrFlag(flagArgs);
  const commitMessage = getFlagValue(flagArgs, '--commit-message')
    ?? 'chore(orchestrace): apply approved agent implementation';

  if (command === 'auth') {
    const code = await runAuthCommand(args.slice(1));
    process.exit(code);
  }

  if (command === 'workspace') {
    const code = await runWorkspaceCommand(args.slice(1));
    process.exit(code);
  }

  if (command === 'replay') {
    const manager = new WorkspaceManager(process.cwd());
    const workspace = workspaceOverride
      ? await manager.selectWorkspace(workspaceOverride)
      : await manager.getActiveWorkspace();
    const code = await runReplayCommand(args.slice(1), workspace.path);
    process.exit(code);
  }

  if (command === 'ui') {
    if (workspaceOverride) {
      const manager = new WorkspaceManager(process.cwd());
      await manager.selectWorkspace(workspaceOverride);
    }

    await startUiServer({
      port: Number.isNaN(portOverride) ? undefined : portOverride,
      workspace: workspaceOverride,
      hmr: uiHmr,
    });
    return;
  }

  const workspaceManager = new WorkspaceManager(process.cwd());
  const workspace = workspaceOverride
    ? await workspaceManager.selectWorkspace(workspaceOverride)
    : await workspaceManager.getActiveWorkspace();

  if (command === 'run') {
    const planPath = args[1];
    if (!planPath) {
      console.error('Error: missing plan file path');
      process.exit(1);
    }

    const absolutePath = resolve(workspace.path, planPath);
    const raw = await readFile(absolutePath, 'utf-8');
    const graph: TaskGraph = JSON.parse(raw);
    const code = await runGraph(graph, {
      autoApprove,
      autoPush,
      commitMessage,
      providerOverride,
      modelOverride,
      workspace,
    });
    process.exit(code);
  } else if (command === 'task') {
    const firstFlagIndex = args.findIndex((arg, idx) => idx > 0 && arg.startsWith('--'));
    const promptParts = firstFlagIndex === -1 ? args.slice(1) : args.slice(1, firstFlagIndex);
    const taskPrompt = promptParts.join(' ').trim();
    if (!taskPrompt) {
      console.error('Error: missing task prompt');
      process.exit(1);
    }

    const resolvedRoute = resolveTaskRoute(taskPrompt, process.env.ORCHESTRACE_TASK_ROUTE).result;
    const dispatch = enforceSafeShellDispatch(taskPrompt, resolvedRoute, 'user');
    const route = dispatch.route;
    console.log(`[route] category=${route.category} strategy=${route.strategy} source=${route.source} confidence=${route.confidence.toFixed(2)} reason=${route.reason}`);

    if (resolvedRoute.category === 'shell_command' && route.category !== 'shell_command') {
      console.log(`[route] shell fallback applied: ${dispatch.shell.reason ?? 'prompt failed shell validation'}`);
    }

    if (route.category === 'shell_command') {
      const code = await runShellCommandRoute(dispatch.shell.command!, workspace.path);
      process.exit(code);
    }

    const graph = buildSingleTaskGraph(taskPrompt, route.category);
    const code = await runGraph(graph, {
      autoApprove,
      autoPush,
      commitMessage,
      providerOverride,
      modelOverride,
      workspace,
    });
    process.exit(code);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
}

async function runGraph(
  graph: TaskGraph,
  options: {
    autoApprove: boolean;
    autoPush: boolean;
    commitMessage: string;
    workspace: WorkspaceEntry;
    providerOverride?: string;
    modelOverride?: string;
  },
): Promise<number> {
  const maxParallel = parseInt(process.env.ORCHESTRACE_MAX_PARALLEL ?? '4', 10);
  const provider = options.providerOverride ?? process.env.ORCHESTRACE_DEFAULT_PROVIDER ?? 'anthropic';
  const model = options.modelOverride ?? process.env.ORCHESTRACE_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514';

  console.log(`\n▶ Running plan: ${graph.name} (${graph.nodes.length} tasks, max ${maxParallel} parallel)`);
  console.log(`Workspace: ${options.workspace.name} (${options.workspace.path})\n`);

  const approvalGate = createApprovalGate(options.autoApprove);

  const onEvent = (event: DagEvent) => {
    const ts = new Date().toISOString().slice(11, 19);
    switch (event.type) {
      case 'task:ready':
        console.log(`  [${ts}] ◇ ready:                 ${event.taskId}`);
        break;
      case 'task:planning':
        console.log(`  [${ts}] ✎ planning:             ${event.taskId}`);
        break;
      case 'task:stream-delta':
        console.log(`  [${ts}] · stream (${event.phase}):      ${previewStreamDelta(event.delta)}`);
        break;
      case 'task:tool-call':
        if (event.status === 'started') {
          console.log(
            `  [${ts}] 🛠 tool (${event.phase}):       ${event.toolName} <- ${previewStreamDelta(event.input ?? '')}`,
          );
        } else {
          const suffix = event.isError ? ' [error]' : '';
          console.log(
            `  [${ts}] 🧾 tool result:          ${event.toolName}${suffix} -> ${previewStreamDelta(event.output ?? '')}`,
          );
        }
        break;
      case 'task:plan-persisted':
        console.log(`  [${ts}] 📝 plan persisted:       ${event.taskId} -> ${event.path}`);
        break;
      case 'task:approval-requested':
        console.log(`  [${ts}] ? approval requested:   ${event.taskId}`);
        break;
      case 'task:approved':
        console.log(`  [${ts}] ✓ approved:             ${event.taskId}`);
        break;
      case 'task:started':
        console.log(`  [${ts}] ▶ started:              ${event.taskId}`);
        break;
      case 'task:implementation-attempt':
        console.log(`  [${ts}] ⚙ implement attempt:    ${event.taskId} (${event.attempt}/${event.maxAttempts})`);
        break;
      case 'task:validating':
        console.log(`  [${ts}] ⌁ validating:           ${event.taskId}`);
        break;
      case 'task:verification-failed':
        console.log(`  [${ts}] ✗ verification failed:  ${event.taskId} (attempt ${event.attempt})`);
        break;
      case 'task:completed':
        console.log(`  [${ts}] ✓ completed:            ${event.taskId} (${event.output.durationMs}ms)`);
        break;
      case 'task:failed':
        console.log(`  [${ts}] ✗ failed:               ${event.taskId} — ${event.error}`);
        break;
      case 'task:retrying':
        console.log(`  [${ts}] ↻ retrying:             ${event.taskId} (attempt ${event.attempt}/${event.maxRetries})`);
        break;
      case 'graph:completed':
        console.log(`\n✓ Plan completed. ${event.outputs.size} task(s) finished.`);
        break;
      case 'graph:failed':
        console.log(`\n✗ Plan failed: ${event.error}`);
        console.log(`  Completed: ${event.completedTasks.join(', ') || 'none'}`);
        console.log(`  Failed:    ${event.failedTasks.join(', ')}`);
        break;
    }
  };

  const llm = new PiAiAdapter();
  const authManager = new ProviderAuthManager();
  const githubAuthManager = createGithubAuthManager();
  const cwd = options.workspace.path;

  const outputs = await orchestrate(graph, {
    llm,
    cwd,
    planOutputDir: resolve(cwd, '.orchestrace', 'plans'),
    promptVersion: process.env.ORCHESTRACE_PROMPT_VERSION,
    policyVersion: process.env.ORCHESTRACE_POLICY_VERSION ?? DEFAULT_AGENT_TOOL_POLICY_VERSION,
    maxParallel,
    defaultModel: { provider, model },
    onEvent,
    requirePlanApproval: true,
    onPlanApproval: approvalGate,
    resolveApiKey: (providerId) => authManager.resolveApiKey(providerId),
    createToolset: ({ phase, task, graphId, provider: activeProvider, model: activeModel, reasoning, taskRequiresWrites }) => createAgentToolset({
      cwd,
      phase,
      taskRequiresWrites,
      taskType: task.type,
      graphId,
      taskId: task.id,
      provider: activeProvider,
      model: activeModel,
      reasoning,
            resolveGithubToken: (resolveOptions) => githubAuthManager.resolveApiKey(GITHUB_PROVIDER_ID, resolveOptions),

      runSubAgent: async (request, _signal) => {
        const subProvider = request.provider ?? activeProvider;
        const subModel = request.model ?? activeModel;
        const subAgentToolset = createReadOnlySubAgentToolset(cwd, taskRequiresWrites);
        const subAgent = await llm.spawnAgent({
          provider: subProvider,
          model: subModel,
          reasoning: request.reasoning ?? reasoning,
          timeoutMs: resolveSubAgentTimeoutMs(),
          systemPrompt: request.systemPrompt
            ?? 'You are a focused sub-agent. Solve the given sub-task and return concise actionable output.',
          toolset: subAgentToolset,
          apiKey: await authManager.resolveApiKey(subProvider),
                    refreshApiKey: () => authManager.resolveApiKey(subProvider, { allowRefresh: false }),
          allowAuthRefreshRetry: false,

        });

        const result = await subAgent.complete(request.prompt);
        return {
          text: result.text,
          usage: result.usage,
        };
      },
    }),
  });

  const runId = createRunId(graph.id);
  const replayDir = await persistRunArtifacts({
    cwd,
    graph,
    outputs,
    runId,
  });
  console.log(`Replay artifacts: ${replayDir}`);

  let totalTokens = 0;
  let totalCost = 0;
  for (const output of outputs.values()) {
    if (output.usage) {
      totalTokens += output.usage.input + output.usage.output;
      totalCost += output.usage.cost;
    }
  }

  if (totalTokens > 0) {
    console.log(`\nTokens: ${totalTokens.toLocaleString()} | Cost: $${totalCost.toFixed(4)}`);
  }

  const anyFailed = [...outputs.values()].some((output) => output.status === 'failed');
  if (!anyFailed && options.autoPush) {
    await commitAndPush(cwd, options.commitMessage);
  }

  return anyFailed ? 1 : 0;
}

function previewStreamDelta(delta: string): string {
  const compact = delta.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return '(blank)';
  }

  return compact.length > 100 ? `${compact.slice(0, 97)}...` : compact;
}

function createRunId(graphId: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${sanitizeForPath(graphId)}_${ts}_${suffix}`;
}

async function persistRunArtifacts(params: {
  cwd: string;
  graph: TaskGraph;
  outputs: Map<string, TaskOutput>;
  runId: string;
}): Promise<string> {
  const outDir = resolve(params.cwd, '.orchestrace', 'runs', params.runId);
  await mkdir(outDir, { recursive: true });

  const nodesById = new Map(params.graph.nodes.map((node) => [node.id, node]));
  const taskSummaries: Array<{ taskId: string; status: string; file: string }> = [];

  for (const output of params.outputs.values()) {
    const node = nodesById.get(output.taskId);
    const replay = output.replay ?? {
      version: 1 as const,
      graphId: params.graph.id,
      taskId: output.taskId,
      promptVersion: 'unknown',
      policyVersion: 'unknown',
      provider: 'unknown',
      model: 'unknown',
      attempts: [],
    };

    const payload = {
      version: 1,
      createdAt: new Date().toISOString(),
      runId: params.runId,
      graphId: params.graph.id,
      graphName: params.graph.name,
      taskId: output.taskId,
      taskName: node?.name,
      taskType: node?.type,
      status: output.status,
      durationMs: output.durationMs,
      retries: output.retries,
      failureType: output.failureType,
      usage: output.usage,
      error: output.error,
      planPath: output.planPath,
      tokenDumpDir: output.tokenDumpDir,
      responsePreview: previewText(output.response),
      validationResults: output.validationResults,
      replay,
    };

    const filename = `${sanitizeForPath(output.taskId)}.json`;
    const filePath = resolve(outDir, filename);
    await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
    taskSummaries.push({ taskId: output.taskId, status: output.status, file: filename });
  }

  const summary = {
    version: 1,
    createdAt: new Date().toISOString(),
    runId: params.runId,
    graphId: params.graph.id,
    graphName: params.graph.name,
    taskCount: taskSummaries.length,
    tasks: taskSummaries,
  };
  await writeFile(resolve(outDir, 'index.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf-8');
  return outDir;
}

function sanitizeForPath(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function previewText(text: string | undefined, maxChars = 1500): string | undefined {
  if (!text) {
    return undefined;
  }

  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return undefined;
  }

  return compact.length > maxChars ? `${compact.slice(0, maxChars - 3)}...` : compact;
}

export function buildSingleTaskGraph(prompt: string, routeCategory: TaskRouteCategory = 'code_change'): TaskGraph {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const verifyCommands = parseVerifyCommands();
  const nodeType = routeCategory === 'refactor' ? 'refactor' : 'code';
  const graphName = routeCategory === 'investigation' ? 'Single Prompt Investigation Task' : 'Single Prompt Task';
  const validationCommands = routeCategory === 'investigation' ? [] : verifyCommands;

  return {
    id: `task-${timestamp}`,
    name: graphName,
    nodes: [
      {
        id: 'task',
        name: 'Execute prompt task',
        type: nodeType,
        prompt,
        dependencies: [],
        validation: {
          commands: validationCommands,
          maxRetries: 2,
          retryDelayMs: 0,
        },
        meta: {
          routeCategory,
        },
      },
    ],
  };
}

async function runShellCommandRoute(command: string, cwd: string): Promise<number> {
    const validation = validateShellInput(command);
  if (!validation.ok || !validation.parsed) {
    console.error(`Shell command validation failed: ${validation.reason ?? 'input did not pass centralized validation'}`);
    return 1;
  }

  try {
    const { stdout, stderr } = await execFileAsync(validation.parsed.program, validation.parsed.args, { cwd });
    if (stdout) {
      process.stdout.write(stdout);
    }

    if (stderr) {
      process.stderr.write(stderr);
    }
    return 0;
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    console.error(`Shell command failed: ${details}`);
    return 1;
  }
}

function parseVerifyCommands(): string[] {
  return parseAndSanitizeVerifyCommands(process.env.ORCHESTRACE_VERIFY_COMMANDS);
}

function getBooleanFlag(args: string[], flag: string, fallback: boolean): boolean {
  if (args.includes(flag)) return true;
  return fallback;
}

function getFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function getUiHmrFlag(args: string[]): boolean {
  if (args.includes('--no-hmr')) {
    return false;
  }

  if (args.includes('--hmr')) {
    return true;
  }

  const envValue = process.env.ORCHESTRACE_UI_HMR;
  if (envValue) {
    return envValue !== 'false';
  }

  return true;
}

function createApprovalGate(autoApprove: boolean): (request: PlanApprovalRequest) => Promise<boolean> {
  if (autoApprove) {
    return async () => true;
  }

  let queue = Promise.resolve();

  return async (request: PlanApprovalRequest): Promise<boolean> => {
    let approved = false;
    queue = queue.then(async () => {
      approved = await askForPlanApproval(request);
    });
    await queue;
    return approved;
  };
}

async function askForPlanApproval(request: PlanApprovalRequest): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error(`\nApproval required for ${request.task.id}, but stdin is not interactive.`);
    return false;
  }

  console.log(`\nPlan for task \"${request.task.id}\" saved at:\n  ${request.planPath}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Approve this plan and proceed with implementation? [y/N]: ');
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function commitAndPush(cwd: string, commitMessage: string): Promise<void> {
  const status = await runGit(cwd, ['status', '--porcelain']);
  if (!status.trim()) {
    console.log('\nNo git changes detected. Skipping commit/push.');
    return;
  }

  console.log('\nPreparing git commit and push...');
  await runGit(cwd, ['add', '-A']);

  try {
    await runGit(cwd, ['commit', '-m', commitMessage]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('nothing to commit')) {
      console.log('Nothing to commit after staging. Skipping push.');
      return;
    }
    throw err;
  }

  await runGit(cwd, ['push']);
  console.log('Git push completed.');
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, { cwd });
  return `${stdout}${stderr}`;
}

async function runAuthCommand(args: string[]): Promise<number> {
  const manager = new ProviderAuthManager();
  const providers = manager.listProviders();
  const subcommand = args[0];

  if (subcommand === 'status') {
    await printAuthStatus(manager, providers);
    return 0;
  }

  const providerId = subcommand === 'login' ? args[1] : subcommand;
  let provider: ProviderInfo | undefined;
  if (providerId) {
    provider = providers.find((item) => item.id === providerId);
    if (!provider) {
      console.error(`Unknown provider: ${providerId}`);
      console.error('Run `orchestrace auth` to select from available providers.');
      return 1;
    }
  } else {
    provider = await selectProviderInteractive(providers);
    if (!provider) {
      return 1;
    }
  }

  const method = await selectAuthMethod(provider);
  if (!method) {
    return 1;
  }

  if (method === 'oauth') {
    await runOAuthLogin(manager, provider);
    console.log(`Authenticated ${provider.id} using OAuth and saved credentials to auth.json.`);
    return 0;
  }

  const apiKey = await promptForApiKey(provider);
  if (!apiKey) {
    console.error('Authentication cancelled: API key was empty.');
    return 1;
  }

  const { path } = await manager.configureApiKey(provider.id, apiKey);
  console.log(`Saved API key for ${provider.id} to ${path}.`);
  return 0;
}

async function printAuthStatus(manager: ProviderAuthManager, providers: ProviderInfo[]): Promise<void> {
  const statuses = await manager.getAllStatus();
  const byProvider = new Map(statuses.map((status) => [status.provider, status]));

  console.log('\nProvider auth status:\n');
  for (const provider of providers) {
    const status = byProvider.get(provider.id);
    const source = status?.source ?? 'none';
    const details = [];
    if (status?.storedApiKeyConfigured) details.push('store');
    if (status?.envConfigured) details.push('env');
    if (status?.oauthConfigured) details.push('oauth');

    console.log(
      `- ${provider.id.padEnd(22)} auth=${provider.authType.padEnd(6)} status=${source.padEnd(4)} ${details.join('+')}`,
    );
  }

  console.log('\nUse `orchestrace auth` to authenticate a provider.');
}

async function runWorkspaceCommand(args: string[]): Promise<number> {
  const manager = new WorkspaceManager(process.cwd());
  const subcommand = args[0] ?? 'list';

  if (subcommand === 'list') {
    await printWorkspaceList(manager);
    return 0;
  }

  if (subcommand === 'current') {
    const active = await manager.getActiveWorkspace();
    console.log(`\nActive workspace:\n- id: ${active.id}\n- name: ${active.name}\n- path: ${active.path}`);
    return 0;
  }

  if (subcommand === 'add') {
    const workspacePath = args[1];
    if (!workspacePath) {
      console.error('Usage: orchestrace workspace add <path> [--name <friendly-name>]');
      return 1;
    }

    const name = getFlagValue(args, '--name');
    const entry = await manager.addWorkspace(workspacePath, name);
    console.log(`\nAdded workspace and set active: ${entry.name} (${entry.id})\nPath: ${entry.path}`);
    return 0;
  }

  if (subcommand === 'select') {
    const identifier = args[1];
    if (!identifier) {
      console.error('Usage: orchestrace workspace select <id|name|path>');
      return 1;
    }

    const entry = await manager.selectWorkspace(identifier);
    console.log(`\nActive workspace set to: ${entry.name} (${entry.id})\nPath: ${entry.path}`);
    return 0;
  }

  if (subcommand === 'remove') {
    const identifier = args[1];
    if (!identifier) {
      console.error('Usage: orchestrace workspace remove <id|name|path>');
      return 1;
    }

    const result = await manager.removeWorkspace(identifier);
    console.log(`\nRemoved workspace: ${result.removedId}`);
    console.log(`Active workspace: ${result.activeWorkspaceId}`);
    return 0;
  }

  console.error('Unknown workspace subcommand.');
  console.error('Usage:');
  console.error('  orchestrace workspace list');
  console.error('  orchestrace workspace current');
  console.error('  orchestrace workspace add <path> [--name <friendly-name>]');
  console.error('  orchestrace workspace select <id|name|path>');
  console.error('  orchestrace workspace remove <id|name|path>');
  return 1;
}

async function runReplayCommand(args: string[], workspacePath: string): Promise<number> {
  const firstArg = args[0];
  const subcommand = firstArg === 'show' || firstArg === 'list' ? firstArg : undefined;
  if (subcommand === 'list') {
    const limit = parsePositiveInt(getFlagValue(args, '--limit')) ?? 20;
    return listReplayRuns(workspacePath, limit);
  }

  const runId = subcommand ? args[1] : firstArg;
  const taskId = getFlagValue(args, '--task');

  if (!runId) {
    console.error('Usage: orchestrace replay show <runId> [--task <taskId>]');
    return 1;
  }

  if (!isSafePathSegment(runId)) {
    console.error(`Invalid runId: ${runId}`);
    return 1;
  }

  const runDir = resolve(workspacePath, '.orchestrace', 'runs', runId);
  const indexPath = resolve(runDir, 'index.json');

  let index: ReplayRunIndex;
  try {
    const raw = await readFile(indexPath, 'utf-8');
    index = JSON.parse(raw) as ReplayRunIndex;
  } catch {
    console.error(`Run artifact not found: ${runId}`);
    console.error(`Expected file: ${indexPath}`);
    return 1;
  }

  if (!taskId) {
    console.log(`\nRun: ${index.runId}`);
    console.log(`Graph: ${index.graphName ?? '(unknown)'} (${index.graphId ?? '(unknown)'})`);
    console.log(`Created: ${index.createdAt ?? '(unknown)'}`);
    console.log(`Tasks: ${(index.tasks ?? []).length}`);
    for (const task of index.tasks ?? []) {
      console.log(`- ${task.taskId.padEnd(24)} status=${task.status.padEnd(9)} file=${task.file}`);
    }
    console.log('\nUse --task <taskId> to inspect per-attempt replay details.');
    return 0;
  }

  const taskSummary = (index.tasks ?? []).find((entry) => entry.taskId === taskId);
  if (!taskSummary) {
    const available = (index.tasks ?? []).map((entry) => entry.taskId).join(', ') || '(none)';
    console.error(`Task not found in run ${runId}: ${taskId}`);
    console.error(`Available tasks: ${available}`);
    return 1;
  }

  const taskPath = resolve(runDir, taskSummary.file);
  let taskArtifact: ReplayTaskArtifact;
  try {
    const raw = await readFile(taskPath, 'utf-8');
    taskArtifact = JSON.parse(raw) as ReplayTaskArtifact;
  } catch {
    console.error(`Task artifact file is missing or invalid: ${taskPath}`);
    return 1;
  }

  console.log(`\nRun: ${taskArtifact.runId}`);
  console.log(`Task: ${taskArtifact.taskId} (${taskArtifact.taskName ?? 'unnamed'})`);
  console.log(`Type: ${taskArtifact.taskType ?? 'unknown'} | Status: ${taskArtifact.status}`);
  console.log(`Duration: ${taskArtifact.durationMs}ms | Retries: ${taskArtifact.retries}`);
  if (taskArtifact.failureType) {
    console.log(`Failure type: ${taskArtifact.failureType}`);
  }
  console.log(`Usage: ${formatUsage(taskArtifact.usage)}`);
  if (taskArtifact.error) {
    console.log(`Error: ${taskArtifact.error}`);
  }

  const replay = taskArtifact.replay;
  if (!replay) {
    console.log('\nNo replay payload is available for this task artifact.');
    return 0;
  }

  console.log(`\nReplay:`);
  console.log(`- promptVersion: ${replay.promptVersion}`);
  console.log(`- policyVersion: ${replay.policyVersion}`);
  console.log(`- model: ${replay.provider}/${replay.model}${replay.reasoning ? ` (${replay.reasoning})` : ''}`);
  console.log(`- attempts: ${replay.attempts.length}`);

  for (const attempt of replay.attempts) {
    const toolCalls = attempt.toolCalls?.length ?? 0;
    const validation = attempt.validation
      ? ` validation=${attempt.validation.passed ? 'pass' : 'fail'}`
      : '';
    const stop = attempt.stopReason ? ` stop=${attempt.stopReason}` : '';
    const error = attempt.error ? ` error=${attempt.error}` : '';
    const failureType = attempt.failureType ? ` failureType=${attempt.failureType}` : '';
    console.log(
      `  - ${attempt.phase}#${attempt.attempt} ${attempt.provider}/${attempt.model}${stop}${validation}${failureType} tools=${toolCalls}${error}`,
    );
    if (attempt.usage) {
      console.log(`    usage: ${formatUsage(attempt.usage)}`);
    }
    if (attempt.textPreview) {
      console.log(`    preview: ${attempt.textPreview}`);
    }
    if (attempt.endpoint) {
      console.log(`    endpoint: ${attempt.endpoint}`);
    }
  }

  return 0;
}

async function listReplayRuns(workspacePath: string, limit: number): Promise<number> {
  const runsRoot = resolve(workspacePath, '.orchestrace', 'runs');

  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    console.log('No replay runs found.');
    console.log(`Expected directory: ${runsRoot}`);
    return 0;
  }

  const runs: Array<{ runId: string; createdAt: string; graphName: string; taskCount: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runId = entry.name;
    if (!isSafePathSegment(runId)) {
      continue;
    }

    const indexPath = resolve(runsRoot, runId, 'index.json');
    try {
      const raw = await readFile(indexPath, 'utf-8');
      const index = JSON.parse(raw) as ReplayRunIndex;
      runs.push({
        runId,
        createdAt: index.createdAt ?? '',
        graphName: index.graphName ?? index.graphId ?? '(unknown)',
        taskCount: index.taskCount ?? index.tasks?.length ?? 0,
      });
    } catch {
      continue;
    }
  }

  const sorted = runs
    .sort((a, b) => {
      const byTime = b.createdAt.localeCompare(a.createdAt);
      if (byTime !== 0) {
        return byTime;
      }
      return b.runId.localeCompare(a.runId);
    })
    .slice(0, limit);

  if (sorted.length === 0) {
    console.log('No replay runs found.');
    console.log(`Expected directory: ${runsRoot}`);
    return 0;
  }

  console.log(`\nReplay runs (${sorted.length}/${runs.length}):`);
  for (const run of sorted) {
    const created = run.createdAt || '(unknown time)';
    console.log(`- ${run.runId} | ${created} | graph=${run.graphName} | tasks=${run.taskCount}`);
  }
  console.log('\nUse: orchestrace replay show <runId> [--task <taskId>]');
  return 0;
}

function isSafePathSegment(value: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(value);
}

function formatUsage(usage: { input: number; output: number; cost: number } | undefined): string {
  if (!usage) {
    return 'n/a';
  }

  return `in=${usage.input}, out=${usage.output}, cost=$${usage.cost.toFixed(4)}`;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function resolveSubAgentTimeoutMs(): number {
  return parsePositiveInt(process.env.ORCHESTRACE_SUBAGENT_TIMEOUT_MS)
    ?? parsePositiveInt(process.env.ORCHESTRACE_LLM_DELEGATION_TIMEOUT_MS)
    ?? parsePositiveInt(process.env.ORCHESTRACE_LLM_LONG_TURN_TIMEOUT_MS)
    ?? 300_000;
}

async function printWorkspaceList(manager: WorkspaceManager): Promise<void> {
  const state = await manager.list();

  console.log(`\nWorkspace store: ${manager.getStorePath()}`);
  console.log('Registered workspaces:\n');

  state.workspaces.forEach((workspace, index) => {
    const marker = workspace.id === state.activeWorkspaceId ? '*' : ' ';
    console.log(`${index + 1}. [${marker}] ${workspace.name}`);
    console.log(`   id:   ${workspace.id}`);
    console.log(`   path: ${workspace.path}`);
  });

  if (state.workspaces.length === 0) {
    console.log('(none)');
  }
}

async function selectProviderInteractive(providers: ProviderInfo[]): Promise<ProviderInfo | undefined> {
  if (!process.stdin.isTTY) {
    console.error('Interactive provider selection requires a TTY.');
    return undefined;
  }

  console.log('\nSelect a provider to authenticate:\n');
  providers.forEach((provider, index) => {
    console.log(`${index + 1}. ${provider.id} (${provider.authType})`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nEnter number or provider id: ');
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed) return undefined;

  const asIndex = Number.parseInt(trimmed, 10);
  if (!Number.isNaN(asIndex) && asIndex >= 1 && asIndex <= providers.length) {
    return providers[asIndex - 1];
  }

  return providers.find((provider) => provider.id === trimmed);
}

async function selectAuthMethod(provider: ProviderInfo): Promise<'oauth' | 'api-key' | undefined> {
  if (provider.authType === 'oauth') return 'oauth';
  if (provider.authType === 'api-key') return 'api-key';

  if (!process.stdin.isTTY) {
    return 'oauth';
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `Provider ${provider.id} supports OAuth and API key. Choose method [oauth/api-key] (default oauth): `,
  );
  rl.close();

  const normalized = answer.trim().toLowerCase();
  if (normalized === 'api-key' || normalized === 'api' || normalized === 'key') {
    return 'api-key';
  }
  return 'oauth';
}

async function runOAuthLogin(manager: ProviderAuthManager, provider: ProviderInfo): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    if (provider.id === 'github-copilot') {
      console.log('\nGitHub Copilot uses device/mobile code authentication.');
    }

    await manager.loginOAuth(provider.id, {
      onAuth: (info) => {
        console.log(`\nOpen this URL in your browser:\n${info.url}`);
        if (info.instructions) {
          console.log(info.instructions);
        }
      },
      onProgress: (message) => {
        console.log(message);
      },
      onPrompt: async (prompt) => {
        const suffix = prompt.placeholder ? ` (${prompt.placeholder})` : '';
        while (true) {
          const answer = await rl.question(`${prompt.message}${suffix}: `);
          if (answer.length > 0 || prompt.allowEmpty) {
            return answer;
          }
        }
      },
      onManualCodeInput: async () => rl.question('Paste authorization code: '),
    });
  } finally {
    rl.close();
  }
}

async function promptForApiKey(provider: ProviderInfo): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    return undefined;
  }

  const envHint = provider.envVars[0] ? ` (${provider.envVars[0]})` : '';
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const apiKey = await rl.question(`Enter API key for ${provider.id}${envHint}: `);
  rl.close();

  return apiKey.trim() || undefined;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
