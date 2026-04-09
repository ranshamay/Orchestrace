# Orchestrace

Vendor-agnostic agent orchestration system. Define task graphs (or a single prompt task), then execute them with a generalized lifecycle: deep planning, plan persistence, explicit approval, implementation, and verification retries.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     @orchestrace/cli                     │
│                  CLI entry point / runner                 │
├─────────────────────────────────────────────────────────┤
│                    @orchestrace/core                     │
│  DAG Engine │ Scheduler │ Orchestrator │ Validator        │
├──────────────────┬──────────────────────────────────────┤
│ @orchestrace/    │         @orchestrace/sandbox          │
│    provider      │  Git Worktrees │ Runtime Helpers      │
│  (pi-ai BYOK)   │  Parallel Isolation │ Native Local Runtime │
└──────────────────┴──────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@orchestrace/core` | DAG engine, dependency scheduler, orchestration loop, validation |
| `@orchestrace/provider` | LLM abstraction wrapping [pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) — BYOK multi-provider |
| `@orchestrace/sandbox` | Native git worktree isolation and runtime sandbox helpers |
| `@orchestrace/cli` | CLI to execute task graph plans |

## Quick Start

```bash
# Install
pnpm install

# Authenticate provider (OAuth or API key, persisted in auth.json)
pnpm --filter @orchestrace/cli dev auth

# Credentials are saved to repo-root auth.json by default
# Override with: ORCHESTRACE_AUTH_FILE=/custom/path/auth.json

# GitHub Copilot supports device/mobile code OAuth flow
pnpm --filter @orchestrace/cli dev auth github-copilot

# Optional: use an API key from environment/secret manager
export GITHUB_COPILOT_API_KEY=...


# Start local dashboard (status, start/cancel, auth)
pnpm --filter @orchestrace/cli dev ui --port 4310

# Register additional repos/workspaces (1..N) and switch active workspace
pnpm --filter @orchestrace/cli dev workspace add /path/to/another-repo --name another-repo
pnpm --filter @orchestrace/cli dev workspace list
pnpm --filter @orchestrace/cli dev workspace select another-repo

# Run a plan
pnpm --filter @orchestrace/cli dev run examples/feature-plan.json

# Run a single prompt task with automatic routing (shell/investigation/code)
pnpm --filter @orchestrace/cli dev task "Add structured logging to the scheduler"

# Authenticate a provider (interactive)
pnpm --filter @orchestrace/cli dev auth

# Check provider auth status
pnpm --filter @orchestrace/cli dev auth status

# Override provider/model per run
pnpm --filter @orchestrace/cli dev task "Fix flaky tests" --provider github-copilot --model gpt-4o

# Run against a specific workspace without changing current active selection
pnpm --filter @orchestrace/cli dev task "Refactor parser" --workspace /path/to/another-repo

# Optional fallback: env vars still work if you prefer them
export ANTHROPIC_API_KEY=sk-...
```

## Task Graph Format

```json
{
  "id": "add-auth",
  "name": "Add authentication",
  "nodes": [
    {
      "id": "plan",
      "name": "Create implementation plan",
      "type": "plan",
      "prompt": "Analyze the codebase and create a plan for adding JWT auth...",
      "dependencies": [],
      "model": { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "reasoning": "high" }
    },
    {
      "id": "implement",
      "name": "Implement auth middleware",
      "type": "code",
      "prompt": "Based on the plan, implement the JWT auth middleware...",
      "dependencies": ["plan"],
      "validation": {
        "commands": ["pnpm tsc --noEmit", "pnpm vitest run"],
        "maxRetries": 2,
        "retryDelayMs": 2000
      }
    },
    {
      "id": "tests",
      "name": "Write tests",
      "type": "test",
      "prompt": "Write comprehensive tests for the auth middleware...",
      "dependencies": ["implement"],
      "validation": {
        "commands": ["pnpm vitest run"],
        "maxRetries": 1
      }
    },
    {
      "id": "review",
      "name": "Code review",
      "type": "review",
      "prompt": "Review the implementation for security issues, edge cases...",
      "dependencies": ["implement", "tests"]
    }
  ]
}
```

## Key Features

- **Task DAG** — Define dependencies between tasks; the scheduler resolves execution order automatically
- **Generalized execution flow** — Every task follows plan -> persist -> approve -> implement -> verify
- **Model-scoped agent spawning** — Provider creates a dedicated agent instance for the selected model per task
- **Parallel execution** — Independent tasks run concurrently (configurable `maxParallel`)
- **Validation gates** — Run shell commands (tsc, vitest, eslint) after each task; auto-retry on failure
- **Iterative verification loop** — Validation failures are fed into the next attempt until criteria are met
- **Per-task model selection** — Use fast models for simple tasks, reasoning models for complex ones
- **Multi-workspace support** — Register multiple repos, switch active workspace, and run tasks per workspace in CLI and UI
- **BYOK** — Bring your own keys for OpenAI, Anthropic, Google, Groq, xAI, Mistral, or any OpenAI-compatible API
- **Approval gate** — Plans are persisted under `.orchestrace/plans/...` and require user approval before implementation
- **Git finalize** — Optional stage/commit/push after success (`--push`)
- **Git worktree isolation** — Parallel tasks get their own worktree to avoid conflicts
- **Sandbox helpers** — Runtime helper primitives for native local execution workflows
- **Sub-agent support** — Parallel runs execute in dedicated git worktrees

## Supported Providers (via pi-ai)

OpenAI, Anthropic, Google, Vertex AI, Mistral, Groq, Cerebras, xAI, OpenRouter, Amazon Bedrock, and any OpenAI-compatible API (Ollama, vLLM, LM Studio, etc.)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

### Monorepo internal package resolution

Internal `@orchestrace/*` packages publish `main`/`types` from `dist/`, so build outputs must exist before strict typecheck/test flows in dependent packages.

- Use the root workflow in clean environments:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm test
```

- Package-level `typecheck`/`test` scripts include `pretypecheck`/`pretest` hooks that build that package and its internal workspace dependencies first (via `pnpm --filter <pkg>... build`).

### Targeted package tests (`@orchestrace/tools`)

When targeting a package test via pnpm filter, keep the `--` separator before Vitest arguments.

```bash
# Full tools package tests
pnpm --filter @orchestrace/tools test

# Target a specific file from workspace root
pnpm --filter @orchestrace/tools test -- tests/toolset.test.ts

# Target file + test name pattern
pnpm --filter @orchestrace/tools test -- tests/toolset.test.ts -t "createAgentToolset phase policy"

# Alternative: run Vitest directly in the filtered package context
pnpm --filter @orchestrace/tools exec vitest run tests/toolset.test.ts
```


## License

MIT
