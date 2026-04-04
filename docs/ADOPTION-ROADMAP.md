# Orchestrace Adoption Roadmap (2 Weeks)

This roadmap translates high-value ideas from modern coding-agent systems into original Orchestrace implementation work. It focuses on product patterns and architecture, not copying external source code.

## Goals

- Increase reliability and debuggability of autonomous runs.
- Make agent behavior measurable in CI.
- Improve safety and cost predictability.
- Keep changes incremental across existing package boundaries.

## Scope (Priority Order)

1. Deterministic run replay artifacts.
2. Golden eval harness in CI.
3. Prompt and policy version stamping.
4. Failure classification with targeted recovery.

## Week 1

### 1) Deterministic Run Replay (P0)

#### Deliverable

Persist a replay artifact per task run with enough data to reconstruct behavior and compare regressions.

#### Package Changes

- `packages/core`
  - Add replay event payload types in `src/dag/types.ts`.
  - Extend orchestrator event flow in `src/orchestrator/orchestrator.ts`.
- `packages/provider`
  - Emit normalized attempt metadata in `src/adapter.ts`.
  - Include stop reason, usage, and model endpoint in replay metadata.
- `packages/cli`
  - Persist artifacts under `.orchestrace/runs/<runId>/<taskId>.json`.
  - Add command: `orchestrace replay show <runId> [--task <taskId>]`.
- `packages/ui`
  - Add a basic run inspector panel (metadata + tool call timeline).

#### Replay Artifact Schema (v1)

```json
{
  "version": 1,
  "runId": "2026-04-04T12-30-00Z_abc123",
  "graphId": "single-task",
  "taskId": "implement",
  "provider": "github-copilot",
  "model": "gpt-5.3-codex",
  "reasoning": "medium",
  "promptVersion": "impl-v1",
  "policyVersion": "tools-v1",
  "attempts": [
    {
      "attempt": 1,
      "startedAt": "...",
      "completedAt": "...",
      "stopReason": "end_turn",
      "toolCalls": [
        { "name": "read_file", "inputPreview": "...", "outputPreview": "...", "isError": false }
      ],
      "usage": { "input": 1200, "output": 600, "cost": 0 },
      "validation": { "passed": false, "commandResults": [{ "command": "pnpm vitest run", "exitCode": 1 }] }
    }
  ]
}
```

#### Acceptance Criteria

- Every task completion (success/failure) writes one artifact file.
- Artifact includes all attempts, usage, stop reason, and tool-call previews.
- CLI can print a readable summary from a stored run artifact.

#### Tests

- `packages/core/tests/orchestrator/replay.test.ts`:
  - writes artifact on success.
  - writes artifact on failure.
  - includes tool-call and usage entries.

### 2) Prompt + Policy Version Stamping (P1)

#### Deliverable

Introduce explicit version IDs for prompts and tool permissions, and stamp them into each run artifact.

#### Package Changes

- `packages/core`
  - Add optional `promptVersion` and `policyVersion` fields in task execution context.
- `packages/tools`
  - Add `policyVersion` field to resolved permissions in `src/policy.ts`.
- `packages/provider`
  - Include prompt version tags in request metadata for logs.

#### Acceptance Criteria

- Run artifacts always contain non-empty `promptVersion` and `policyVersion`.
- Defaults are deterministic when not explicitly configured.

## Week 2

### 3) Golden Eval Harness (P0)

#### Deliverable

Create a deterministic eval suite that runs representative tasks and scores pass/fail in CI.

#### Package Changes

- New workspace package: `packages/evals`
  - `src/cases/*.json` for task inputs.
  - `src/judges/*.ts` for measurable assertions.
  - `src/run-evals.ts` runner with JSON summary output.
- Root config
  - Add `pnpm --filter @orchestrace/evals test` to CI pipeline.

#### Example Cases

- `fix-failing-test`:
  - Asserts target test passes and no unrelated files changed.
- `safe-refactor`:
  - Asserts compile success and API surface unchanged.
- `docs-update`:
  - Asserts markdown edits only and lint clean.

#### Metrics

- pass rate.
- median attempts per task.
- token usage per successful run.
- validation retry rate.

#### Acceptance Criteria

- CI publishes an eval summary artifact.
- PRs touching `packages/core`, `packages/provider`, or `packages/tools` run evals.
- Baseline threshold enforced (for example, pass rate >= 80%).

### 4) Failure Classification + Targeted Recovery (P1)

#### Deliverable

Map failures into typed buckets and apply bucket-specific retries/prompts.

#### Buckets (v1)

- `timeout`
- `auth`
- `rate_limit`
- `tool_schema`
- `tool_runtime`
- `validation`
- `empty_response`
- `unknown`

#### Package Changes

- `packages/provider`
  - Add classifier module under `src/adapter/failure-classifier.ts`.
  - Emit `failureType` in adapter failure dumps.
- `packages/core`
  - Adjust retry strategy in orchestrator to use bucket-specific guidance.
- `packages/ui`
  - Show failure type badges in session timeline.

#### Acceptance Criteria

- Failures are classified for >= 90% of observed cases.
- Recovery retries improve success rate for tool/runtime failures.

## Engineering Order (Day-by-Day)

1. Day 1: Replay schema + core event wiring.
2. Day 2: Provider attempt metadata + tool-call capture finalization.
3. Day 3: CLI persistence + `replay show` command.
4. Day 4: Prompt/policy version stamping.
5. Day 5: Week 1 hardening + tests.
6. Day 6: `packages/evals` scaffolding + first 2 eval cases.
7. Day 7: CI integration + threshold gate.
8. Day 8: Failure classifier + adapter integration.
9. Day 9: Orchestrator recovery policy by bucket.
10. Day 10: UI failure badges + docs + release notes.

## Suggested Commands

```bash
pnpm -r build
pnpm -r test
pnpm --filter @orchestrace/cli dev task "small smoke run"
pnpm --filter @orchestrace/evals test
```

## Risks and Mitigations

- Risk: replay files become too large.
  - Mitigation: store previews by default and gate full payload capture behind env flag.
- Risk: eval flakiness from live model variance.
  - Mitigation: use deterministic judges and stable prompts; report variance windows.
- Risk: over-retry inflates cost.
  - Mitigation: bucket-specific retry caps and hard wall-clock budget.

## Definition of Done

- Replay artifacts and inspector are available for every run.
- Evals run in CI with enforced baseline.
- Prompt/policy versions are stamped and queryable.
- Failure classification is visible and improves recovery outcomes.