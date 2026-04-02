# Orchestrace

Vendor-agnostic agent orchestration system. Define task graphs with dependencies, run them in parallel with configurable validation, retry, and model selection per task.

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
│    provider      │  Git Worktrees │ Docker Containers    │
│  (pi-ai BYOK)   │  Parallel Isolation │ Cloud Runtime   │
└──────────────────┴──────────────────────────────────────┘
```

## Packages

| Package | Description |
|---------|-------------|
| `@orchestrace/core` | DAG engine, dependency scheduler, orchestration loop, validation |
| `@orchestrace/provider` | LLM abstraction wrapping [pi-ai](https://www.npmjs.com/package/@mariozechner/pi-ai) — BYOK multi-provider |
| `@orchestrace/sandbox` | Git worktree isolation + Docker container management |
| `@orchestrace/cli` | CLI to execute task graph plans |

## Quick Start

```bash
# Install
pnpm install

# Set your API key
export ANTHROPIC_API_KEY=sk-...

# Run a plan
pnpm --filter @orchestrace/cli dev run examples/feature-plan.json
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
- **Parallel execution** — Independent tasks run concurrently (configurable `maxParallel`)
- **Validation gates** — Run shell commands (tsc, vitest, eslint) after each task; auto-retry on failure
- **Per-task model selection** — Use fast models for simple tasks, reasoning models for complex ones
- **BYOK** — Bring your own keys for OpenAI, Anthropic, Google, Groq, xAI, Mistral, or any OpenAI-compatible API
- **Git worktree isolation** — Parallel tasks get their own worktree to avoid conflicts
- **Docker sandbox** — Run tasks in isolated containers for cloud execution
- **Sub-agent support** — Tasks marked `isolated: true` run in separate worktrees

## Supported Providers (via pi-ai)

OpenAI, Anthropic, Google, Vertex AI, Mistral, Groq, Cerebras, xAI, OpenRouter, Amazon Bedrock, and any OpenAI-compatible API (Ollama, vLLM, LM Studio, etc.)

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
