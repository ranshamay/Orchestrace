# Tester Agent — Implementation Plan

## Overview

An embedded **Tester Agent** role in every session's execution flow. After the implementer finishes and basic validation passes, the tester agent reads the plan + code changes, generates targeted tests (unit, API, UI, deployment — whatever the change requires), runs them via a mandatory `run_command` tool, and gates delivery. Rejection loops back to the implementer with the failure evidence.

## Confirmed Design Decisions

1. **Tester rejection consumes an implementer retry** — unified retry budget, no infinite loops
2. **Tester can write test files** — scoped to test directories, crucial for quality automation
3. **Generated tests are persisted** — committed as part of the PR changeset
4. **Separate configurable LLM model** — independently configurable like the observer agent
5. **Opt-in via config** — when enabled, runs on every session with code changes

## Execution Flow

```
Current:
  Plan → Approve → Implement → Validate (shell cmds) → Deliver

New:
  Plan → Approve → Implement → Validate (shell cmds) → TESTER AGENT → Deliver
                                                            ↓ reject
                                                        Implement (retry with test failures as context)
```

When the tester rejects, the rejection reason + test failure output is fed back to the implementer as `previousValidationError`, consuming one retry attempt from the unified budget.

---

## Phase 1: Core Types & Config

**Package: `@orchestrace/core`**

| File | Change |
|---|---|
| `packages/core/src/dag/types.ts` | Add `'testing'` to `TaskStatus`. Add optional `tester?: TesterConfig` to `TaskNode`. |
| `packages/core/src/orchestrator/role-config.ts` | Extend `AgentRole` from `'planner' \| 'implementer'` to `'planner' \| 'implementer' \| 'tester'`. Add `buildTesterPrompt()` and `buildTesterSystemPrompt()`. |

### `TesterConfig` type (on TaskNode)

```typescript
interface TesterConfig {
  /** Whether tester agent is enabled for this task. */
  enabled: boolean;
  /** Override model for the tester agent. */
  model?: ModelConfig;
  /** Require at least one run_command invocation. Default: true. */
  requireRunTests?: boolean;
  /** Timeout for the tester phase in ms. Default: 300_000. */
  timeoutMs?: number;
}
```

### Tester Prompt Design

The tester prompt receives:
- Original task spec/prompt
- The approved plan
- `git diff` of all changes (from `filesChanged` or computed)
- Implementer's validation results (what already passed)
- Instruction to generate and run tests

The system prompt instructs the tester to:
1. Read the spec and plan to understand intent
2. Inspect the code changes
3. Write targeted test files covering the changes
4. Run the tests via `run_command`
5. Emit a structured verdict: `{ approved, testResults, rejectionReason?, suggestedFixes? }`

---

## Phase 2: Tester Prompts

**Package: `@orchestrace/core`**

| File | Change |
|---|---|
| `packages/core/src/orchestrator/role-config.ts` | Add `buildTesterPrompt()` and `buildTesterSystemPrompt()`. Extend `roleToPhase()` to map `'tester'` → `'testing'`. |

### `buildTesterSystemPrompt()` — Key Instructions

```
You are a dedicated test engineer agent. Your role is to verify code changes
by writing and running tests. You MUST:

1. Read the implementation plan and understand the intended behavior.
2. Inspect the code diff to identify what changed.
3. Write test files covering the changes (unit, integration, API, UI as appropriate).
4. Run the tests using run_command. This is MANDATORY — you cannot approve without running tests.
5. Analyze test results and produce a verdict.

You have write access ONLY to test directories. You cannot modify source files.
You MUST call run_command at least once to execute tests.

Output a structured verdict at the end of your response:
{
  "approved": true/false,
  "testsPassed": <number>,
  "testsFailed": <number>,
  "rejectionReason": "<if rejected, explain why>",
  "suggestedFixes": ["<actionable fix suggestions for the implementer>"]
}
```

### `buildTesterPrompt()` — Template

```
## Task Specification
{task.prompt}

## Approved Plan
{approvedPlan}

## Code Changes (git diff)
{gitDiff}

## Prior Validation Results
{validationResults — commands that already passed}

## Instructions
Write tests that verify the implementation matches the spec and plan.
Focus on:
- Correctness of the core behavior
- Edge cases mentioned in the plan
- Regression safety for modified code paths

Run all tests. If all pass, approve. If any fail, reject with clear failure reasons
and suggested fixes so the implementer can address them on the next attempt.
```

---

## Phase 3: Tool Policy Extension

**Package: `@orchestrace/tools`**

| File | Change |
|---|---|
| `packages/tools/src/policy.ts` | Add `'testing'` phase to phase-based permissions. |
| `packages/tools/src/index.ts` | `createAgentToolset()` accepts `phase: 'testing'` and applies tester policy. |

### Testing Phase Permissions

| Tool Category | Access |
|---|---|
| `list_directory` | ✅ |
| `read_file`, `read_files` | ✅ |
| `search_files` | ✅ |
| `git_diff`, `git_status` | ✅ |
| `write_file`, `edit_file` | ✅ scoped to test directories only |
| `run_command` | ✅ **mandatory** (at least one invocation required) |
| `run_command_batch` | ✅ |
| `write_files`, `edit_files` | ✅ scoped to test directories only |
| `todo_*`, `agent_graph_*` | ❌ |
| `subagent_*` | ❌ |
| `mode_*` | ❌ |

### Mandatory Tool Enforcement

```typescript
// In executeTesterRole():
let ranTestCommand = false;
const wrappedOnToolCall = (event: LlmToolCallEvent, replayRecord: ReplayToolCallRecord) => {
  if (event.toolName === 'run_command' || event.toolName === 'run_command_batch') {
    ranTestCommand = true;
  }
  onToolCall?.(event, replayRecord);
};

// After LLM completes:
if (config.requireRunTests && !ranTestCommand) {
  return {
    approved: false,
    reason: 'Tester agent completed without executing any test command. Verdict rejected.',
  };
}
```

---

## Phase 4: Tester Role Executor

**Package: `@orchestrace/core`**

| File | Change |
|---|---|
| `packages/core/src/orchestrator/role-executor.ts` | New `executeTesterRole()` function. |

### `executeTesterRole()` Design

```typescript
export async function executeTesterRole(params: {
  task: TaskNode;
  graphId: string;
  approvedPlan: string;
  implementerOutput: TaskOutput;
  testerModel: ModelConfig;
  testerAgent: LlmAgent;
  signal?: AbortSignal;
  cwd: string;
  emit: (event: DagEvent) => void;
  requireRunTests: boolean;
}): Promise<TesterVerdict> {
  // 1. Build tester prompt with plan + diff + validation results
  // 2. Execute tester agent with tool-call tracking
  // 3. Enforce mandatory run_command
  // 4. Parse structured verdict from output
  // 5. Return TesterVerdict
}

interface TesterVerdict {
  approved: boolean;
  testsPassed: number;
  testsFailed: number;
  testOutput: string;           // raw test command output for evidence
  rejectionReason?: string;
  suggestedFixes?: string[];
  toolCalls: ReplayToolCallRecord[];
  usage: { input: number; output: number; cost: number };
}
```

### New DAG Events

| Event Type | Payload |
|---|---|
| `task:testing` | `{ taskId }` — tester phase started |
| `task:tester-verdict` | `{ taskId, approved, testsPassed, testsFailed, rejectionReason? }` |

---

## Phase 5: Orchestrator Integration

**Package: `@orchestrace/core`**

| File | Change |
|---|---|
| `packages/core/src/orchestrator/orchestrator.ts` | Wire tester phase between implementation validation success and output return. Add `testerConfig`, `defaultTesterModel` to `OrchestratorConfig`. |

### Integration Point

Inside the executor function, after implementation validation passes:

```typescript
// Current code (in executeImplementerRole return path):
if (allPassed) {
  return output;  // ← this is where we insert the tester gate
}

// New code:
if (allPassed) {
  if (testerConfig?.enabled && hasCodeChanges(output)) {
    emit({ type: 'task:testing', taskId: task.id });

    const testerAgent = await spawnRoleAgent({
      llm, role: 'tester', task, graphId: graph.id, cwd,
      model: testerConfig.model ?? defaultTesterModel ?? implementationModel,
      systemPrompt: buildTesterSystemPrompt(...),
      signal: context.signal,
      createToolset,
      resolveApiKey,
      taskRequiresWrites: true, // for test file creation
    });

    const verdict = await executeTesterRole({
      task, graphId: graph.id,
      approvedPlan: planningResult?.text ?? '',
      implementerOutput: output,
      testerModel: testerConfig.model ?? defaultTesterModel ?? implementationModel,
      testerAgent,
      signal: context.signal,
      cwd, emit,
      requireRunTests: testerConfig.requireRunTests ?? true,
    });

    emit({
      type: 'task:tester-verdict',
      taskId: task.id,
      approved: verdict.approved,
      testsPassed: verdict.testsPassed,
      testsFailed: verdict.testsFailed,
      rejectionReason: verdict.rejectionReason,
    });

    if (verdict.approved) {
      output.testerVerdict = verdict;
      return output; // → proceed to delivery
    }

    // Rejection: feed back to implementer retry loop
    lastFailureType = 'validation';
    lastValidationError = [
      `Tester agent rejected the implementation.`,
      `Tests passed: ${verdict.testsPassed}, failed: ${verdict.testsFailed}`,
      verdict.rejectionReason ? `Reason: ${verdict.rejectionReason}` : '',
      verdict.suggestedFixes?.length
        ? `Suggested fixes:\n${verdict.suggestedFixes.map(f => `- ${f}`).join('\n')}`
        : '',
      `Test output:\n${verdict.testOutput}`,
    ].filter(Boolean).join('\n');

    emit({
      type: 'task:verification-failed',
      taskId: task.id, attempt,
      error: lastValidationError,
    });
    continue; // → next implementation attempt
  }

  return output;
}
```

### New `OrchestratorConfig` Fields

```typescript
interface OrchestratorConfig {
  // ... existing fields ...

  /** Tester agent configuration. When enabled, gates delivery with LLM-powered test generation. */
  testerConfig?: {
    enabled: boolean;
    model?: ModelConfig;
    systemPrompt?: string;
    requireRunTests?: boolean;
    timeoutMs?: number;
  };
  /** Default model for tester phase when not overridden per-task. */
  defaultTesterModel?: ModelConfig;
}
```

---

## Phase 6: Tester Agent Config Persistence

**Package: `@orchestrace/cli`**

| File | Change |
|---|---|
| New: `packages/cli/src/tester-config.ts` | `TesterAgentConfig` type, defaults, load/save functions. |

### Config Type

```typescript
interface TesterAgentConfig {
  enabled: boolean;               // default: false
  provider: string;               // default: '' (inherits from implementation)
  model: string;                  // default: '' (inherits from implementation)
  requireRunTests: boolean;       // default: true
  testCategories: TestCategory[]; // default: ['unit', 'integration']
  maxTestRetries: number;         // default: 1
  timeoutMs: number;              // default: 300_000 (5 min)
  testFilePatterns: string[];     // default: ['**/tests/**', '**/*.test.*', '**/*.spec.*']
  approvalThreshold: number;      // default: 1.0 (all must pass)
}

type TestCategory = 'unit' | 'integration' | 'api' | 'ui' | 'deployment';

const DEFAULT_TESTER_CONFIG: TesterAgentConfig = {
  enabled: false,
  provider: '',
  model: '',
  requireRunTests: true,
  testCategories: ['unit', 'integration'],
  maxTestRetries: 1,
  timeoutMs: 300_000,
  testFilePatterns: ['**/tests/**', '**/*.test.*', '**/*.spec.*'],
  approvalThreshold: 1.0,
};
```

### Persistence

- Stored at `.orchestrace/tester/config.json`
- `loadTesterConfig()` — reads + merges with defaults
- `saveTesterConfig()` — writes JSON
- Same pattern as `ObserverDaemon.loadConfig()` / `saveConfig()`

---

## Phase 7: Runner Wiring

**Package: `@orchestrace/cli`**

| File | Change |
|---|---|
| `packages/cli/src/runner.ts` | Load tester config, pass into `orchestrate()` as `testerConfig`. Wire `createToolset` to support `phase: 'testing'`. Emit session-level tester events. |

### Key Changes

1. **Load config on startup:** `const testerConfig = await loadTesterConfig(orchestraceDir);`
2. **Pass to orchestrator:** `orchestrate(graph, { ...config, testerConfig, defaultTesterModel })`
3. **Toolset factory:** extend `createToolset` to handle `phase: 'testing'` with test-scoped write permissions
4. **Auto-checkpoint after tester:** if tester writes test files, checkpoint them before delivery

### New Session Events

| Event | Emitted When |
|---|---|
| `session:tester-started` | Tester agent spawned |
| `session:tester-verdict` | Tester produces verdict (approved/rejected + results) |
| `session:tester-completed` | Tester phase done |

---

## Phase 8: API Routes

**Package: `@orchestrace/cli`**

| File | Change |
|---|---|
| `packages/cli/src/ui-server.ts` | Add tester agent API routes. |

### Routes

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/tester/status` | Returns `{ config, lastResult }` |
| `POST` | `/api/tester/config` | Updates tester config (autosave from UI) |
| `POST` | `/api/tester/enable` | Sets `config.enabled = true`, saves |
| `POST` | `/api/tester/disable` | Sets `config.enabled = false`, saves |

### Implementation Pattern

Follows the existing observer API routes exactly. Config changes call `saveTesterConfig()` and notify the runner of the updated config.

---

## Phase 9: Settings UI

**Package: `@orchestrace/ui`**

| File | Change |
|---|---|
| `packages/ui/src/app/components/settings/SettingsTabView.tsx` | Add `TesterSection` component. |
| `packages/ui/src/lib/api.ts` | Add `TesterConfig` type, API functions. |

### TesterSection UI Layout

Positioned between the Observer section and Providers section in the settings page.

```
┌─────────────────────────────────────────────┐
│ 🧪 Tester Agent                    [Toggle] │
├─────────────────────────────────────────────┤
│ Provider:    [select dropdown         ▾]    │
│ Model:       [autocomplete input       ]    │
│                                             │
│ ☑ Require test execution (run_command)      │
│                                             │
│ Test Categories:                            │
│   ☑ Unit  ☑ Integration  ☐ API             │
│   ☐ UI   ☐ Deployment                      │
│                                             │
│ Approval threshold:  [100] %                │
│ Timeout (seconds):   [300]                  │
│ Max retries:         [1]                    │
│                                             │
│ Test file patterns:                         │
│   **/tests/**                               │
│   **/*.test.*                               │
│   **/*.spec.*                               │
└─────────────────────────────────────────────┘
```

### API Functions

```typescript
// packages/ui/src/lib/api.ts
export interface TesterConfig {
  enabled: boolean;
  provider: string;
  model: string;
  requireRunTests: boolean;
  testCategories: TestCategory[];
  maxTestRetries: number;
  timeoutMs: number;
  testFilePatterns: string[];
  approvalThreshold: number;
}

export async function fetchTesterStatus(): Promise<{ config: TesterConfig }>;
export async function updateTesterConfig(config: Partial<TesterConfig>): Promise<void>;
export async function enableTester(): Promise<void>;
export async function disableTester(): Promise<void>;
```

---

## Phase 10: Session Event Display

**Package: `@orchestrace/ui`**

| File | Change |
|---|---|
| `packages/ui/src/app/utils/timelineItems.ts` | Handle tester events in timeline. |
| `packages/ui/src/app/components/work/SessionSummaryCard.tsx` | Show "Testing" phase badge. |
| `packages/ui/src/app/selectors/sessionViewSelectors.ts` | Derive tester state from events. |

### Timeline Rendering

| Event | Display |
|---|---|
| `session:tester-started` | "🧪 Tester agent started" with testing icon |
| `session:tester-verdict` (approved) | "✅ Tests passed (X/X)" with green badge |
| `session:tester-verdict` (rejected) | "❌ Tests failed (X passed, Y failed)" with red badge + expandable rejection reason + test output |
| `session:tester-completed` | "Tester phase completed" |

### SessionSummaryCard

When tester is active, show a "Testing" phase badge (yellow) between "Implementing" and "Completing".

---

## Phase 11: PR Evidence Injection

**Package: `@orchestrace/cli`**

| File | Change |
|---|---|
| `packages/cli/src/runner.ts` | In `generatePrMetadata()`, append test validation section to PR description. |

### PR Description Addition

When tester verdict exists, append to the LLM-generated PR description:

```markdown
## Test Validation

✅ **Tester agent approved** — all tests passed.

| Metric | Value |
|---|---|
| Tests passed | 12 |
| Tests failed | 0 |
| Test files generated | 2 |
| Tester model | claude-sonnet-4-20250514 |

<details>
<summary>Test output</summary>

```
<raw test command output>
```

</details>
```

---

## Implementation Order (Dependency Graph)

```
Phase 1: Core types ──────────────────────┐
                                          ├─► Phase 4: executeTesterRole()
Phase 2: Tester prompts ─────────────────┤                │
                                          │                ▼
Phase 3: Tool policy ────────────────────┘   Phase 5: Orchestrator wiring
                                                           │
Phase 6: Config persistence (parallel) ───────────────────┤
                                                           ▼
                                              Phase 7: Runner wiring
                                                     │         │
                                                     ▼         ▼
                                           Phase 8: API    Phase 10: Timeline
                                                │          Phase 11: PR evidence
                                                ▼
                                           Phase 9: Settings UI
```

Phases 1-5 are the **core engine** (must be sequential).
Phases 6-8 are the **settings/API surface** (can start phase 6 in parallel with 1-5).
Phases 9-11 are the **UI layer** (depend on phases 7-8).

---

## Files Modified Summary

| Package | File | Type |
|---|---|---|
| `@orchestrace/core` | `packages/core/src/dag/types.ts` | Modify |
| `@orchestrace/core` | `packages/core/src/orchestrator/role-config.ts` | Modify |
| `@orchestrace/core` | `packages/core/src/orchestrator/role-executor.ts` | Modify |
| `@orchestrace/core` | `packages/core/src/orchestrator/orchestrator.ts` | Modify |
| `@orchestrace/tools` | `packages/tools/src/policy.ts` | Modify |
| `@orchestrace/tools` | `packages/tools/src/index.ts` | Modify |
| `@orchestrace/cli` | `packages/cli/src/tester-config.ts` | **New** |
| `@orchestrace/cli` | `packages/cli/src/runner.ts` | Modify |
| `@orchestrace/cli` | `packages/cli/src/ui-server.ts` | Modify |
| `@orchestrace/ui` | `packages/ui/src/app/components/settings/SettingsTabView.tsx` | Modify |
| `@orchestrace/ui` | `packages/ui/src/lib/api.ts` | Modify |
| `@orchestrace/ui` | `packages/ui/src/app/utils/timelineItems.ts` | Modify |
| `@orchestrace/ui` | `packages/ui/src/app/components/work/SessionSummaryCard.tsx` | Modify |
| `@orchestrace/ui` | `packages/ui/src/app/selectors/sessionViewSelectors.ts` | Modify |
