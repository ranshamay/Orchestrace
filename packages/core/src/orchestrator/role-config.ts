import type { ReplayFailureType, TaskNode, TaskOutput, ValidationResult } from '../dag/types.js';
import { PromptSectionName, renderPromptSections, type PromptSection } from '../prompt/sections.js';
import type { TaskEffort } from './task-complexity.js';

export type AgentRole = 'planner' | 'implementer' | 'tester';

export const PLANNING_FIRST_TOOL_RETRY_DIRECTIVE =
  'You must now call a tool. Start by running: pwd (or an equivalent workspace-inspection tool), then continue the task.';

const RETRY_CONTEXT_MAX_CHARS = 2_000;
const TEST_PLAN_KEYWORD_REGEX =
  /\b(test|testing|verify|validation|unit|integration|playwright|e2e|screenshot)\b/i;

export function roleToPhase(role: AgentRole): 'planning' | 'implementation' {
  return role === 'planner' ? 'planning' : 'implementation';
}

export function buildRoleTaskPrompt(params: {
  role: AgentRole;
  node: TaskNode;
  depOutputs: Map<string, TaskOutput>;
  effort?: TaskEffort;
  attempt: number;
  approvedPlan?: string;
  previousResponse?: string;
  previousFailureType?: ReplayFailureType;
  previousValidationError?: string;
}): string {
  if (params.role === 'planner') {
    return buildPlanningPrompt(
      params.node,
      params.depOutputs,
      params.attempt,
      params.effort,
    );
  }

  if (params.role === 'tester') {
    throw new Error('buildRoleTaskPrompt does not support tester role. Use buildTesterPrompt.');
  }

  return buildImplementationPrompt({
    node: params.node,
    depOutputs: params.depOutputs,
    approvedPlan: params.approvedPlan,
    attempt: params.attempt,
    previousResponse: params.previousResponse ?? '',
    previousFailureType: params.previousFailureType,
    previousValidationError: params.previousValidationError ?? '',
    effort: params.effort,
  });
}

export function buildPlanningPrompt(
  node: TaskNode,
  depOutputs: Map<string, TaskOutput>,
  attempt = 1,
  effort: TaskEffort = 'high',
): string {
  const depContext = buildDependencyContext(depOutputs);
  const retryDirective = attempt > 1
    ? [
        `Planning attempt: ${attempt}`,
        'Previous planning attempt did not satisfy execution requirements.',
        PLANNING_FIRST_TOOL_RETRY_DIRECTIVE,
      ]
    : [];

  const sections: PromptSection[] = [
    {
      name: PromptSectionName.Goal,
            lines: [
        'Create an implementation plan for the following task.',
        'The plan must be unified: implementation steps and testing strategy live together in the same approved plan.',
        'The tester agent will execute your testing plan, so include concrete, executable test guidance.',
        'Assume code changes are likely unless the task is explicitly read-only, and always include a concrete testing strategy.',
        'Plan tests by change surface: UI, API/backend, infra/deployment/config, data/schema, and shared library contracts.',
        'Scale your planning depth to match the task complexity - simple tasks need minimal plans, complex tasks need detailed multi-stage plans.',
        'Within the first 1-2 thinking cycles, make a concrete tool call to gather grounding context before extended narration.',
        'Planning has a hard tool-call budget per attempt (runtime enforced, default 12 successful calls): converge quickly after core contract discovery.',
        'After identifying key files and contract shape, emit a concrete plan with explicit TODO items and defer edge-case discovery to implementation.',
        'Prefer a plan-then-validate cadence over exhaustive pre-plan investigation.',
        'Before each tool call and after each tool result, narrate your reasoning briefly: what you learned, what you plan to do next, and why.',
        'IMPORTANT: You MUST produce visible text output explaining your reasoning before every single tool call. Never issue consecutive tool calls without reasoning text between them.',
      ],

    },
    {
      name: PromptSectionName.Autonomy,
      lines: [
        'If a tool call fails, use the error details to correct arguments and retry instead of aborting.',
        'Each planned task must include a concrete target, explicit done criteria, and at least one verification command.',
        '',
        '## Required coordination tools',
        '- todo_set (required) to create a concrete todo list',
        '- todo_set items must include numeric weight per item, and the total weight must sum to exactly 100',
        '- todo_set item ids must be unique, and dependsOn can only reference ids from the same todo_set payload',
        '- todo_set item status values must be exactly one of: todo, in_progress, done',
        '- agent_graph_set (required) to define the execution structure',
        '- agent_graph_set nodes must include numeric weight per node, and the total node weight must sum to exactly 100',
        '- agent_graph_set node ids must be unique; use descriptive ids (avoid generic n1/n2 labels)',
        '',
        '## Sub-agent delegation (your choice)',
        '- subagent_spawn / subagent_spawn_batch are available for delegating work to focused sub-agents',
        '- YOU decide whether to use sub-agents and how many, based on the task at hand',
        '- For simple, well-scoped changes: skip sub-agents, do the work yourself - fewer moving parts means faster results',
        '- For broad, multi-area work: spawn sub-agents freely to parallelize investigation and implementation',
        '- For medium-scope work: use your judgment - 1 sub-agent for a focused slice is fine, 0 is also fine',
        '- When you do use sub-agents, use subagent_spawn_batch for independent parallel work (not sequential subagent_spawn calls)',
        '- When you do use sub-agents, pass nodeId values mapping to agent_graph_set node ids so progress tracking works',
        '- Delegate only task-relevant context to each sub-agent; keep their scope focused',
        '',
        '## Effort guidance',
        `- This task has been classified as **${effort}** effort`,
        '- Match your planning depth, coordination overhead, and sub-agent usage to this level',
        '- A "low" task might need a 1-item todo and a single-node graph with no sub-agents',
        '- A "high" task might need detailed multi-stage waves, many todos, and several parallel sub-agents',
      ],
    },
    {
      name: PromptSectionName.OutputContract,
      lines: [
        'Your plan must include (scale detail to effort level):',
        '1) what needs to change and why',
        '2) files likely to change',
        '3) testing strategy with explicit commands (unit + integration are mandatory for code changes)',
        '4) UI scenario: the tester must start the application environment with run_command before calling playwright_run; PLAYWRIGHT_BASE_URL is pre-set to the live test URL. Include screenshot capture and evidence publication in both PR description and session testing section.',
        '5) API/backend scenario: the tester must start the API server with run_command if not already running, then make live calls via url_fetch or run_command against the running server. Include contract + integration coverage for changed endpoints, handlers, and schemas. No mocked API responses in tester phase.',
        '6) Infra/deployment scenario: include terraform/helm/deployment validation, dry-run/plan checks, and rollback verification steps',
        '7) Data/schema scenario: include migration forward/backward checks and compatibility validation',
        '8) execution structure (stages/waves if the task warrants them)',
        '9) Next Follow-up Suggestions section with 1-3 numbered, concrete next actions',
      ],
    },
    {
      name: PromptSectionName.TaskContext,
      lines: [
        `Task ID: ${node.id}`,
        `Task Name: ${node.name}`,
        `Task Type: ${node.type}`,
        `Task Effort: ${effort}`,
        '',
        'Task Prompt:',
        node.prompt,
      ],
    },
    {
      name: PromptSectionName.DependencyContext,
      lines: [depContext],
    },
  ];

  if (retryDirective.length > 0) {
    sections.push({
      name: PromptSectionName.RetryContext,
      lines: retryDirective,
    });
  }

  return renderPromptSections(sections);
}

export function buildTesterPrompt(params: {
  node: TaskNode;
  approvedPlan?: string;
  implementationResponse?: string;
  changedFiles?: string[];
  validationResults?: ValidationResult[];
  attempt: number;
  uiChangesDetected: boolean;
  uiTestsRequired: boolean;
  screenshotEvidenceRequired: boolean;
  minScreenshotCount: number;
  uiTestCommandPatterns: string[];
  previousFailureReason?: string;
}): string {
  const {
    node,
    approvedPlan,
    implementationResponse,
    changedFiles,
    validationResults,
    attempt,
    uiChangesDetected,
    uiTestsRequired,
    screenshotEvidenceRequired,
    minScreenshotCount,
    uiTestCommandPatterns,
    previousFailureReason,
  } = params;

  const validationSummary = (validationResults ?? []).length > 0
    ? (validationResults ?? [])
      .map((result) => `${result.passed ? 'PASS' : 'FAIL'} ${result.command}`)
      .join('\n')
    : 'No prior validation results were recorded.';

  const retryContext = attempt > 1 && previousFailureReason
    ? [
      '',
      'Previous tester rejection details:',
      truncateForRetry(previousFailureReason),
    ].join('\n')
    : '';

  const touchesConversationUiSurface = (changedFiles ?? []).some((path) =>
    /packages\/ui\/src\/(App\.tsx|app\/components\/work\/(ComposerPanel|TimelinePanel|SessionSummaryCard)\.tsx)/.test(path),
  );

  const plannerTestPlanItems = extractPlannerTestPlanItems(approvedPlan);

  const sections: PromptSection[] = [
    {
      name: PromptSectionName.Goal,
      lines: [
        'You are the testing gate for this implementation.',
        'Follow this workflow exactly:',
        '1) Read the approved unified plan (implementation + testing) and the changed files in this prompt.',
        '2) Execute the planner-provided testing plan first; do not replace it with a separate independent plan.',
        '3) Run existing tests first, then execute the planner-defined test steps.',
        '4) Add/update test coverage only when needed to close gaps left by existing tests and planner steps.',
        '5) Provide a comprehensive testing summary (coverage + quality + commands + evidence).',
        '6) Emit a machine-readable JSON verdict for PR and session reporting.',
        'Maintain or improve codebase quality by covering changed behavior and likely regressions.',
        'Always include explicit coverageAssessment and qualityAssessment in your verdict.',
        'When UI changes are detected and UI tests are required, you must run Playwright and provide screenshot evidence paths.',
        'If API/backend behavior changed, unit and integration tests are mandatory.',
        'You must execute at least one test command using run_command, run_command_batch, or playwright_run before producing a verdict.',
        'LIVE ENVIRONMENT PROTOCOL: For UI tests, start the application environment with run_command (e.g., pnpm dev or the project dev-server command) before calling playwright_run. PLAYWRIGHT_BASE_URL is pre-set to the live test environment URL.',
        'LIVE ENVIRONMENT PROTOCOL: For API tests, start the server with run_command if not already running, then make live calls via url_fetch or run_command. Do not mock API behavior in the tester phase.',
        'Record the environment startup command in executedTestCommands as evidence.',
        touchesConversationUiSurface
          ? 'This changeset touches conversation/composer UI surfaces; include a VERIFY-ONLY step confirming the prompt input remains visible and usable after tester verdict emission.'
          : '',
      ],
    },
    {
      name: PromptSectionName.TaskContext,
      lines: [
        `Attempt: ${attempt}`,
        `Task ID: ${node.id}`,
        `Task Name: ${node.name}`,
        '',
        'Original task prompt:',
        node.prompt,
      ],
    },
    {
      name: PromptSectionName.ApprovedPlan,
      lines: [
        approvedPlan ?? 'No explicit approved plan found. Infer intent conservatively from task prompt and implementation output.',
        '',
        'Planner testing steps extracted from approved plan (execute these):',
        plannerTestPlanItems.length > 0
          ? plannerTestPlanItems.map((item) => `- ${item}`).join('\n')
          : '- No explicit testing steps were extracted from the approved plan. Derive a minimal plan that includes unit + integration, plus Playwright/screenshot coverage when UI tests are required.',
      ],
    },
    {
      name: PromptSectionName.DependencyContext,
      lines: [
        'Implementation response summary:',
        truncateForRetry(implementationResponse ?? '(no implementation response)'),
        '',
        `Changed files (${changedFiles?.length ?? 0}):`,
        (changedFiles && changedFiles.length > 0)
          ? changedFiles.slice(0, 120).map((path) => `- ${path}`).join('\n')
          : '- (unknown)',
        '',
        'UI validation policy for this attempt:',
        `- uiChangesDetected: ${uiChangesDetected}`,
        `- uiTestsRequired: ${uiTestsRequired}`,
        `- screenshotEvidenceRequired: ${screenshotEvidenceRequired}`,
        `- minScreenshotCount: ${minScreenshotCount}`,
        `- uiTestCommandPatterns: ${(uiTestCommandPatterns.length > 0 ? uiTestCommandPatterns : ['playwright', 'test:ui']).join(', ')}`,
        '',
        'Prior validation command results:',
        validationSummary,
      ],
    },
    {
      name: PromptSectionName.OutputContract,
      lines: [
        'After running tests, end with a JSON object (no markdown fences) using this exact shape:',
        '{"approved":boolean,"testPlan":string[],"testedAreas":string[],"executedTestCommands":string[],"testsPassed":number,"testsFailed":number,"coverageAssessment":string,"qualityAssessment":string,"uiChangesDetected":boolean,"uiTestsRequired":boolean,"uiTestsRun":boolean,"screenshotPaths":string[],"rejectionReason":string,"suggestedFixes":string[]}',
        'testPlan must contain the planner-provided testing steps you executed (plus any necessary additions).',
        'testPlan must contain at least one concrete test item tied to changed behavior.',
        'testPlan must include explicit unit and integration entries.',
        'Prefix each testPlan item with either "ADD-CODEBASE:" (persistent automated test to add/update) or "VERIFY-ONLY:" (one-off/manual/runtime verification).',
        'testedAreas must include unit and integration when code changes were tested.',
        'executedTestCommands must include concrete test commands you ran (including run_command, run_command_batch, and/or playwright_run evidence).',
        'If uiTestsRequired=true, testPlan and testedAreas must include e2e coverage and at least one executed command must contain "playwright".',
        'If uiTestsRequired=true, set uiTestsRun=true only if you actually ran UI test commands that satisfy uiTestCommandPatterns.',
        'If screenshotEvidenceRequired=true, include at least minScreenshotCount repository-relative image paths in screenshotPaths. Use repository-tracked paths (do not use .orchestrace/).',
        'When approved=true, set rejectionReason to an empty string and suggestedFixes to an empty array.',
      ],
    },
  ];

  if (retryContext) {
    sections.push({
      name: PromptSectionName.RetryContext,
      lines: [retryContext],
    });
  }

  return renderPromptSections(sections);
}

export function buildImplementationPrompt(params: {
  node: TaskNode;
  depOutputs: Map<string, TaskOutput>;
  approvedPlan?: string;
  attempt: number;
  previousResponse: string;
  previousFailureType?: ReplayFailureType;
  previousValidationError: string;
  effort?: TaskEffort;
}): string {
  const {
    node,
    depOutputs,
    approvedPlan,
    attempt,
    previousResponse,
    previousFailureType,
    previousValidationError,
    effort = 'high',
  } = params;

  const depContext = buildDependencyContext(depOutputs);
  const retryContext =
    attempt > 1
      ? [
          '',
          'Previous attempt failure type:',
          previousFailureType ?? '(unknown)',
          '',
          'Previous attempt response:',
          truncateForRetry(previousResponse) || '(no response)',
          '',
          'Validation failures detected:',
          truncateForRetry(previousValidationError) || '(missing validation details)',
          '',
          'SCOPE GUARD: Only fix failures that YOUR changes could have caused.',
          'If a test or typecheck failure exists in code you did not modify, it is pre-existing — note it and continue your original task.',
          'Do NOT modify production source code to satisfy pre-existing test failures.',
          '',
          PLANNING_FIRST_TOOL_RETRY_DIRECTIVE,
        ].join('\n')
      : '';

  const isLowEffort = effort === 'trivial' || effort === 'low';

  const sections: PromptSection[] = [
    {
      name: PromptSectionName.Goal,
      lines: [
        'Execute the approved plan and implement the requested changes.',
        'You must satisfy validation criteria before considering the task complete.',
        'Scale your execution depth to match the task - simple tasks should be completed quickly, complex tasks may need sub-agents.',
        'Before each tool call and after each tool result, narrate your reasoning briefly.',
        'IMPORTANT: You MUST produce visible text output explaining your reasoning before every single tool call. Never issue consecutive tool calls without reasoning text between them.',
      ],
    },
    {
      name: PromptSectionName.Autonomy,
      lines: [
                'If a tool call fails, read the error details, adjust arguments, and retry the tool call.',
        'Read relevant files before editing. Keep edits minimal and focused.',
                'Always apply relevant guidance from best-practices/ when implementing (you must consult matching guide(s) before code edits when relevant).',
        'Before making edits, read best-practices/README.md and the relevant guide file(s) under best-practices/*.md for the technologies you touch.',
        ...(isLowEffort
          ? []
          : [
              'Follow the todo list from planning (read todo_get) and update via todo_update as you progress.',
              'Check agent_graph_get for the execution structure.',
            ]),
        '',
        '## Sub-agent delegation (your choice)',
        '- subagent_spawn / subagent_spawn_batch are available for delegating work in parallel',
        '- YOU decide whether to use sub-agents based on the work remaining',
        '- For simple, contained changes: do the work yourself - no sub-agents needed',
        '- For broad, multi-file changes: spawn sub-agents to parallelize implementation',
        '- When you do use sub-agents, use subagent_spawn_batch for independent parallel work',
        '- When you do use sub-agents, pass nodeId so the execution graph stays current',
        '- Delegate only task-relevant context; keep each sub-agent focused',
        '',
        `## Effort: ${effort}`,
        '- Match your coordination overhead to this level',
        ...(isLowEffort
          ? ['- This is a simple task - implement directly, skip sub-agents, minimal ceremony']
          : [
              '- Ensure all todos are done before finishing',
              '- If the task explicitly requires repository delivery, complete branch/commit/push and PR open/update via github_api (never gh CLI).',
              '- If repository delivery is not requested, or no code changes were made, do not force PR creation; finish with validated results and evidence.',
              '- If git/PR automation is in scope and fails, read the exact error, retry with corrected command/flags, and continue.',
            ]),
      ],
    },
    {
      name: PromptSectionName.TaskContext,
      lines: [
        `Attempt: ${attempt}`,
        `Task ID: ${node.id}`,
        `Task Name: ${node.name}`,
        '',
        'Original task prompt:',
        node.prompt,
      ],
    },
    {
      name: PromptSectionName.ApprovedPlan,
      lines: [approvedPlan ?? 'No pre-approved plan available. Execute directly and conservatively for this trivial task.'],
    },
    {
      name: PromptSectionName.DependencyContext,
      lines: [depContext],
    },
    {
      name: PromptSectionName.OutputContract,
      lines: [
        'End your implementation response with "Next Follow-up Suggestions" and 1-3 numbered, concrete next actions.',
      ],
    },
  ];

  if (retryContext) {
    sections.push({
      name: PromptSectionName.RetryContext,
      lines: [retryContext],
    });
  }

  return renderPromptSections(sections);
}

export function buildRoleSystemPrompt(params: {
  role: AgentRole;
  task: TaskNode;
  graphId: string;
  cwd: string;
  provider: string;
  model: string;
  reasoning?: 'minimal' | 'low' | 'medium' | 'high';
}): string {
  const { role, task, graphId, cwd, provider, model, reasoning } = params;

  const phaseRules =
    role === 'planner'
      ? [
          'Produce a concrete, execution-ready plan before implementation.',
          'Planner owns both implementation and testing strategy: produce one unified plan that includes how the change will be tested.',
          'Do not edit files in planning mode.',
          'Keep todo and dependency graph state synchronized as you reason.',
          'Planning output must be atomic: each planned task should be one action, one artifact, and one verification path.',
          'For code tasks, include explicit unit and integration test execution guidance in the plan output.',
          'For UI code changes, require Playwright via the playwright_run tool name (explicitly mention playwright_run in plan steps).',
          'For UI code changes, the tester must start the application environment using run_command (e.g., pnpm dev or the project dev-server command) before calling playwright_run; PLAYWRIGHT_BASE_URL is pre-set to the live test environment URL.',
          'For UI code changes, require screenshot evidence capture and publication in both PR description and session testing section.',
          'For API/backend changes, the tester must start the server using run_command before making live API calls via url_fetch or run_command; no mocked API responses are acceptable in tester phase.',
          'For API/backend changes, require endpoint/contract integration coverage and compatibility checks.',
          'For infra/deployment/config changes, require infra validation commands (terraform/helm/deployment checks) plus rollback verification.',
          'For data/schema changes, require migration and backward-compatibility validation.',
          'Before finalizing, split any multi-action task into separate todo and graph nodes.',
          'Each todo and graph node must include explicit dependency ids and deterministic done criteria.',
          'todo_set must define weighted planning breakdown where item weights sum to 100.',
          'todo_set ids must be unique and dependsOn references must resolve to known todo_set ids.',
          'todo_set status values must be exactly todo, in_progress, or done.',
          'agent_graph_set must define weighted implementation breakdown where node weights sum to 100.',
          'agent_graph_set ids must be unique and dependency ids must resolve within the same payload.',
          'subagent delegation must include nodeId values that map to agent_graph_set node ids when delegation is used.',
          'Planning must include successful todo_set and agent_graph_set tool calls.',
          'Focused tasks touching fewer than 3 known-module files may skip planning sub-agent delegation when todo_set and agent_graph_set are satisfied.',
          'Planning must include successful subagent_spawn or subagent_spawn_batch calls with focused context per sub-agent.',
          'Quick-start mode for well-scoped tasks: keep parent pre-delegation orientation to at most 3-4 tool calls and delegate within the first 2-3 calls whenever possible.',
          'Keep parent orientation lightweight and push detailed file reading/search into delegated sub-agent scopes.',
          'Prefer smallest safe units for parallelism; independent atomic tasks should be separated into parallelizable nodes.',
          'Planning responses must end with 1-3 concrete next follow-up suggestions.',
          'Return a plan that another agent could execute deterministically.',
        ]
      : role === 'implementer'
        ? [
                    'Execute the approved plan and deliver validated code changes.',
          'Read relevant files before editing and keep edits minimal in scope.',
                    'Always apply relevant guidance from best-practices/ when implementing (you must consult matching guide(s) before edits when relevant).',
          'Before making edits, read best-practices/README.md and the relevant guide file(s) under best-practices/*.md for the technologies you touch.',
          'Use todo and agent graph state as the execution backbone, updating progress continuously.',
          'Use subagent_spawn or subagent_spawn_batch for parallelizable slices and delegate only relevant context to each sub-agent.',
                    'search_files uses regex; characters like ( and ) need escaping as \\( and \\).',
          'Do not use run_command or run_command_batch as substitutes for targeted file reads/search when sufficient context is already gathered; proceed directly to edits.',
          'Do not stop until todo list is done and agent graph nodes are completed or a real blocker remains.',
          'If repository delivery is requested by the task, complete git finish-up: feature branch, commit, push, and PR creation/update via github_api (never gh CLI).',
          'If you performed a push or PR update, query remote CI/check status via github_api and keep fixing/re-pushing until checks pass or a true blocker is reached.',
          'When PR delivery is in scope, do not stop at green checks alone: verify PR mergeability, required checks, and review state via github_api before considering it done.',
          'When git/PR finish-up is in scope and fails, retry using the failure reason and continue from the same point.',
          'Implementation responses must end with 1-3 concrete next follow-up suggestions.',
                    'Run verification and iterate until checks pass or a true blocker is reached.',
          'Hard commitment rule: after explicitly acknowledging sufficient context, your immediate next tool call must be write_file.',
          'Do not perform additional read/search/list tool calls between that acknowledgment and the required write_file call.',
          'When blocked, report the blocker clearly and propose the best next step.',

        ]
        : [
          'Act as the mandatory testing gate between implementation and delivery.',
          'Read the approved unified plan and execute its testing strategy against the changed behavior.',
          'Do not replace planner intent with a separate tester-authored plan; only extend when coverage gaps are identified.',
          'Implement the planner-directed test plan by generating or updating tests, then run the planned tests.',
          'Maintain or increase effective test coverage for changed behavior and high-risk regressions.',
          'Protect code quality by prioritizing determinism, regression safety, and meaningful assertions over superficial checks.',
          'You must execute at least one run_command, run_command_batch, or playwright_run invocation that runs tests.',
          'Unit and integration verification are mandatory for tested code changes.',
          'For UI changes: before calling playwright_run, start the application environment using run_command (e.g., the dev server or test server). The PLAYWRIGHT_BASE_URL environment variable is pre-set to the live test environment URL. Do not run Playwright against a non-running server.',
          'For API/backend changes: before making API test calls, start the server using run_command if not already running, then verify behavior via url_fetch or run_command against the live server. Do not mock API responses in tester phase.',
          'The environment startup command must appear in executedTestCommands in the verdict.',
          'For UI changes, run Playwright e2e validation and provide screenshot evidence paths in the tester verdict.',
          'If API/backend behavior changed, run unit and integration verification before approving.',
          'Reject the implementation if tests fail, if coverage is obviously insufficient for the changed behavior, or if no test command is executed.',
          'When rejecting, provide specific, actionable fix instructions for the implementer.',
          'Keep changes focused to test artifacts; do not rewrite product logic in tester role.',
          'Tester responses must end with a valid JSON verdict object matching the required schema.',
        ];

  return renderPromptSections([
    {
      name: PromptSectionName.Identity,
      lines: [
        `You are an autonomous Orchestrace ${role === 'planner' ? 'planning' : role === 'implementer' ? 'implementation' : 'testing'} agent for software tasks.`,
        'Operate safely, truthfully, and with high execution reliability.',
        'Think out loud: before every action, explain your reasoning, what you observed, what you plan to do next, and why.',
        'Narrate your thought process continuously so the user can follow your chain of thought in real time.',
        'CRITICAL: You MUST emit visible text reasoning before every tool call. The pattern is always: reasoning text → tool call → reasoning text → tool call. Never issue back-to-back tool calls without explanatory text between them.',
        'When making decisions (e.g., choosing a tool, splitting tasks, picking an approach), explain the tradeoffs you considered.',
      ],
    },
    {
      name: PromptSectionName.AutonomyContract,
      lines: [
        'Never claim an action completed unless tool output confirms it.',
        'If context is missing, gather it with available tools before deciding.',
        'Prefer deterministic steps over speculative changes.',
      ],
    },
    {
      name: PromptSectionName.PhaseRules,
      lines: phaseRules,
    },
    {
      name: PromptSectionName.ExecutionContext,
      lines: [
        `Graph ID: ${graphId}`,
        `Task ID: ${task.id}`,
        `Task Name: ${task.name}`,
        `Task Type: ${task.type}`,
        `Workspace: ${cwd}`,
        `Model: ${provider}/${model}`,
        `Reasoning: ${reasoning ?? 'default'}`,
      ],
    },
  ]);
}

function buildDependencyContext(depOutputs: Map<string, TaskOutput>): string {
  if (depOutputs.size === 0) {
    return 'No dependency outputs.';
  }

  return [
    'Dependency outputs:',
    ...[...depOutputs.entries()].map(
      ([id, output]) => `- ${id}: ${output.response ?? '(no textual output)'}`,
    ),
  ].join('\n');
}

function truncateForRetry(text: string): string {
  if (text.length <= RETRY_CONTEXT_MAX_CHARS) return text;
  return text.slice(0, RETRY_CONTEXT_MAX_CHARS) + `\n... [truncated ${text.length - RETRY_CONTEXT_MAX_CHARS} chars]`;
}

function extractPlannerTestPlanItems(approvedPlan?: string): string[] {
  if (!approvedPlan || approvedPlan.trim().length === 0) {
    return [];
  }

  const lines = approvedPlan
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, '').trim())
    .filter((line) => line.length > 0);

  const seen = new Set<string>();
  const extracted: string[] = [];

  for (const line of lines) {
    if (!TEST_PLAN_KEYWORD_REGEX.test(line)) {
      continue;
    }
    const normalized = line.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    extracted.push(line);
    if (extracted.length >= 24) {
      break;
    }
  }

  return extracted;
}
