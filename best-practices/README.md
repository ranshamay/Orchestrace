# Best Practices Knowledge Base

This folder is a curated collection of expert-level best practices for the Orchestrace technology stack.  
Use these guides as implementation standards for design, coding, testing, deployment, and operational reliability.

## Table of Contents

## Languages

- [TypeScript & JavaScript](./typescript-javascript.md) — Type-safety, module patterns, async/error handling, and production-grade TS/JS conventions.
- [HTML & CSS](./html-css.md) — Semantic markup, accessibility, maintainable styling patterns, and performance-focused CSS practices.
- [Shell Scripting](./shell-scripting.md) — Safe bash patterns, portability, error handling, and robust automation script design.
- [Markdown & JSON](./markdown-json.md) — Documentation consistency, structured data quality, schema validation, and formatting discipline.

## Runtime & Monorepo

- [Node.js Runtime](./nodejs-runtime.md) — Event loop safety, performance tuning, memory patterns, and secure runtime operations.
- [pnpm Workspaces](./pnpm-workspaces.md) — Workspace dependency strategy, filtering workflows, lockfile hygiene, and cross-package coordination.
- [Turborepo](./turborepo.md) — Task graph design, caching correctness, pipeline dependencies, and CI optimization patterns.

## Frontend Framework

- [React, React DOM, React Router DOM](./react.md) — Component architecture, hooks/effects correctness, rendering performance, and route/data loading patterns.

## Build & Styling

- [Vite + @vitejs/plugin-react](./vite.md) — Build/dev server setup, env handling, plugin strategy, bundle optimization, and monorepo alignment.
- [Tailwind CSS + PostCSS + Autoprefixer](./tailwindcss.md) — Utility-first conventions, tokenized design systems, plugin ordering, and style performance.

## UI Utilities

- [UI Utilities (Lucide, React Markdown, Remark GFM, CVA, clsx, tailwind-merge)](./ui-utilities.md) — Icon/accessibility patterns, safe markdown rendering, and scalable class composition.

## Testing

- [Vitest](./testing-vitest.md) — Unit/integration testing strategy, mocks, async testing, coverage, and deterministic test design.
- [Playwright + @playwright/test](./testing-playwright.md) — E2E reliability, selector strategy, auth/network mocking, CI stability, and debugging workflows.

## Code Quality

- [Linting & Formatting (ESLint, typescript-eslint, Prettier)](./linting-formatting.md) — Rule architecture, flat config patterns, formatter boundaries, and CI gating.
- [Type Tooling (TypeScript, tsx, @types/*)](./type-tooling.md) — TS config strictness, script execution, declaration hygiene, and advanced typing patterns.
- [Coding Standards (Modular & Testable Code)](./coding-standards.md) — Architectural boundaries, dependency injection, side-effect isolation, and maintainable code design rules.
- [Testing Standards (Unit/Integration/E2E)](./testing-standards.md) — Test pyramid policy, deterministic testing rules, and CI-quality testing standards.


## AI & Token Tooling

- [@mariozechner/pi-ai + js-tiktoken](./ai-token-tooling.md) — Token budgeting, context compaction, guardrails, retry discipline, and cost-aware AI integration.

## Infrastructure

- [Terraform & Deployment Infra](./terraform-infra.md) — State management, secure IaC patterns, module structure, deploy safety, and drift-aware workflows.

## Dev Process

- [concurrently + dotenv](./dev-process-tooling.md) — Multi-process dev orchestration, environment loading discipline, and secret-safe script operations.

---

## How to Use These Guides

1. **During implementation**: consult the relevant file(s) before introducing new code in that technology area.
2. **During code review**: use each guide’s checklist section as a PR review rubric.
3. **During onboarding**: read the category-specific docs that match your first task scope.
4. **During incident/postmortem follow-ups**: map root causes to checklist gaps and update the relevant guide.

Recommended workflow for implementer agents (future wiring):

- Detect technologies touched by a task.
- Inject matching `best-practices/*.md` guides into task context.
- Enforce checklist items during validation before marking work complete.

---

## Contributing / Updating Guides

When updating or adding a guide:

- Keep the same section structure:
  - Overview
  - Key Principles
  - Best Practices (with ✅ DO / ❌ DON'T examples)
  - Common Mistakes
  - Checklist
- Prefer concrete, repo-relevant examples over generic advice.
- Explain **why** a practice exists, not just what to do.
- Keep security, performance, and maintainability concerns explicit.
- Update this index when file names or categories change.

If you introduce a new stack technology, add a dedicated guide and link it here in the proper category.