import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { config as loadDotEnv } from 'dotenv';
import { orchestrate } from '@orchestrace/core';
import type { TaskGraph, DagEvent, PlanApprovalRequest } from '@orchestrace/core';
import { PiAiAdapter, ProviderAuthManager } from '@orchestrace/provider';
import type { ProviderInfo } from '@orchestrace/provider';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
loadDotEnv({ quiet: true });

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
orchestrace — DAG-based agent orchestration

Usage:
  orchestrace run <plan.json>   Execute a task graph from a JSON plan file
  orchestrace task <prompt>     Run a single prompt task using the generalized flow
  orchestrace auth              Interactive provider selection + authentication
  orchestrace auth status       Show auth status for providers
  orchestrace --help            Show this help

Flags:
  --provider <id>               Provider override (e.g. github-copilot, anthropic)
  --model <id>                  Model override for the selected provider
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
  OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, etc.
  ORCHESTRACE_DEFAULT_PROVIDER   Default LLM provider (default: anthropic)
  ORCHESTRACE_DEFAULT_MODEL      Default model ID
  ORCHESTRACE_MAX_PARALLEL       Max concurrent tasks (default: 4)
  ORCHESTRACE_AUTO_APPROVE       true/false plan auto-approval
  ORCHESTRACE_AUTO_PUSH          true/false auto git commit + push
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
  const commitMessage = getFlagValue(flagArgs, '--commit-message')
    ?? 'chore(orchestrace): apply approved agent implementation';

  if (command === 'auth') {
    const code = await runAuthCommand(args.slice(1));
    process.exit(code);
  }

  if (command === 'run') {
    const planPath = args[1];
    if (!planPath) {
      console.error('Error: missing plan file path');
      process.exit(1);
    }

    const absolutePath = resolve(planPath);
    const raw = await readFile(absolutePath, 'utf-8');
    const graph: TaskGraph = JSON.parse(raw);
    const code = await runGraph(graph, {
      autoApprove,
      autoPush,
      commitMessage,
      providerOverride,
      modelOverride,
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

    const graph = buildSingleTaskGraph(taskPrompt);
    const code = await runGraph(graph, {
      autoApprove,
      autoPush,
      commitMessage,
      providerOverride,
      modelOverride,
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
    providerOverride?: string;
    modelOverride?: string;
  },
): Promise<number> {
  const maxParallel = parseInt(process.env.ORCHESTRACE_MAX_PARALLEL ?? '4', 10);
  const provider = options.providerOverride ?? process.env.ORCHESTRACE_DEFAULT_PROVIDER ?? 'anthropic';
  const model = options.modelOverride ?? process.env.ORCHESTRACE_DEFAULT_MODEL ?? 'claude-sonnet-4-20250514';

  console.log(`\n▶ Running plan: ${graph.name} (${graph.nodes.length} tasks, max ${maxParallel} parallel)\n`);

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
  const cwd = process.cwd();

  const outputs = await orchestrate(graph, {
    llm,
    cwd,
    maxParallel,
    defaultModel: { provider, model },
    onEvent,
    requirePlanApproval: true,
    onPlanApproval: approvalGate,
    resolveApiKey: (providerId) => authManager.resolveApiKey(providerId),
  });

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

function buildSingleTaskGraph(prompt: string): TaskGraph {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const verifyCommands = parseVerifyCommands();

  return {
    id: `task-${timestamp}`,
    name: 'Single Prompt Task',
    nodes: [
      {
        id: 'task',
        name: 'Execute prompt task',
        type: 'code',
        prompt,
        dependencies: [],
        validation: {
          commands: verifyCommands,
          maxRetries: 2,
          retryDelayMs: 0,
        },
      },
    ],
  };
}

function parseVerifyCommands(): string[] {
  const raw = process.env.ORCHESTRACE_VERIFY_COMMANDS;
  if (!raw) {
    return ['pnpm typecheck', 'pnpm test'];
  }

  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
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

  const { envVar } = await manager.configureApiKey(provider.id, apiKey);
  console.log(`Saved API key for ${provider.id} to .env (${envVar}).`);
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
    if (status?.envConfigured) details.push('env');
    if (status?.oauthConfigured) details.push('oauth');

    console.log(
      `- ${provider.id.padEnd(22)} auth=${provider.authType.padEnd(6)} status=${source.padEnd(4)} ${details.join('+')}`,
    );
  }

  console.log('\nUse `orchestrace auth` to authenticate a provider.');
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
    await manager.loginOAuth(provider.id, {
      onAuth: (info) => {
        console.log(`\nOpen this URL to authenticate:\n${info.url}`);
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
