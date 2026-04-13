# Best Practices Knowledge Base

## Purpose

This folder is a curated, expert-level knowledge base for the Orchestrace technology stack.

It is designed to help:

- **Human developers** make consistent implementation decisions
- **AI implementer agents** follow repo-aligned standards and avoid common pitfalls

Each guide includes:

- Overview
- DO (recommended patterns with examples)
- DON'T (anti-patterns)
- Configuration guidance
- Project-specific notes for this monorepo

## How to Use

### For AI agents

1. Identify the task’s technology surface (e.g., React + Tailwind + Vitest).
2. Read the relevant guide(s) in this folder before generating changes.
3. Apply the **DO** patterns and avoid **DON’T** examples.
4. Re-check configuration snippets against real repo files before editing.
5. Enforce strict gates:
   - No source file over **200 LOC** (unless documented approved exception)
   - Add/update tests for behavior changes
   - Do not proceed with known failing validations in touched scope


### For human developers

1. Start from the guide matching your area (frontend, infra, tooling, etc.).
2. Use code examples as templates for new features.
3. Include these patterns in code review criteria.
4. Update guides as stack versions or architecture evolve.

---

## Table of Contents

### Core Languages & Runtime

- [TypeScript, JavaScript, Node.js](./typescript-javascript-nodejs.md)

### Build & Monorepo Tooling

- [pnpm workspaces, Turborepo, Vite](./pnpm-turborepo-vite.md)

### Frontend Framework

- [React, React DOM, React Router DOM, @vitejs/plugin-react](./react-ecosystem.md)

### Styling & CSS

- [Tailwind CSS, PostCSS, Autoprefixer, CSS](./tailwind-css-postcss.md)

### UI Utilities

- [Lucide React, React Markdown, Remark GFM, CVA, clsx, tailwind-merge](./ui-utilities.md)

### Testing

- [Testing standards (cross-cutting)](./testing-standards.md)
- [Vitest, Playwright, @playwright/test](./vitest-playwright.md)

### Coding Standards

- [Coding standards (cross-cutting)](./coding-standards.md)


### Code Quality

- [ESLint, typescript-eslint, @eslint/js, react-hooks plugin, react-refresh plugin, Prettier](./eslint-prettier.md)

### TypeScript Tooling

- [TypeScript advanced config, tsx, @types packages](./typescript-tooling.md)

### AI & Token Management

- [@mariozechner/pi-ai, js-tiktoken](./ai-token-tooling.md)

### Infrastructure

- [Terraform (HCL), Shell deployment scripts](./terraform-shell-scripts.md)

### Development Process

- [concurrently, dotenv, globals, Markdown, JSON, HTML](./dev-process-tooling.md)

---

## Strict standards baseline (repo-wide)

- **Coding:** modular design, clear boundaries, and **no more than 200 LOC per source file**.
- **Testing:** behavior-focused coverage, deterministic tests, mandatory regression tests for bug fixes.
- **Quality gates:** lint + typecheck + tests required before merge.

## Contributing


When adding or updating a guide:

1. Keep the same section structure: **Overview / DO / DON'T / Configuration / Project-specific notes**.
2. Prefer practical snippets over generic theory.
3. Include both happy-path and failure/anti-pattern examples.
4. Keep guidance version-aware when possible.
5. Cross-link related guides when patterns overlap.

Suggested filename pattern: `technology-group.md` in kebab-case.

---

## Quick Reference: Package → Guide

| Package / Technology | Guide |
|---|---|
| typescript | [typescript-javascript-nodejs.md](./typescript-javascript-nodejs.md), [typescript-tooling.md](./typescript-tooling.md) |
| node / node.js runtime | [typescript-javascript-nodejs.md](./typescript-javascript-nodejs.md) |
| pnpm / pnpm workspaces | [pnpm-turborepo-vite.md](./pnpm-turborepo-vite.md) |
| turbo | [pnpm-turborepo-vite.md](./pnpm-turborepo-vite.md) |
| vite | [pnpm-turborepo-vite.md](./pnpm-turborepo-vite.md) |
| @vitejs/plugin-react | [react-ecosystem.md](./react-ecosystem.md), [pnpm-turborepo-vite.md](./pnpm-turborepo-vite.md) |
| react / react-dom | [react-ecosystem.md](./react-ecosystem.md) |
| react-router-dom | [react-ecosystem.md](./react-ecosystem.md) |
| tailwindcss | [tailwind-css-postcss.md](./tailwind-css-postcss.md) |
| postcss / autoprefixer | [tailwind-css-postcss.md](./tailwind-css-postcss.md) |
| lucide-react | [ui-utilities.md](./ui-utilities.md) |
| react-markdown / remark-gfm | [ui-utilities.md](./ui-utilities.md) |
| class-variance-authority / clsx / tailwind-merge | [ui-utilities.md](./ui-utilities.md) |
| coding standards (cross-cutting) | [coding-standards.md](./coding-standards.md) |
| testing standards (cross-cutting) | [testing-standards.md](./testing-standards.md) |
| vitest | [vitest-playwright.md](./vitest-playwright.md) |
| playwright / @playwright/test | [vitest-playwright.md](./vitest-playwright.md) |

| eslint / @eslint/js / typescript-eslint | [eslint-prettier.md](./eslint-prettier.md) |
| eslint-plugin-react-hooks / eslint-plugin-react-refresh | [eslint-prettier.md](./eslint-prettier.md) |
| prettier | [eslint-prettier.md](./eslint-prettier.md) |
| tsx | [typescript-tooling.md](./typescript-tooling.md) |
| @types/node / @types/react / @types/react-dom | [typescript-tooling.md](./typescript-tooling.md) |
| @mariozechner/pi-ai / js-tiktoken | [ai-token-tooling.md](./ai-token-tooling.md) |
| terraform / hcl | [terraform-shell-scripts.md](./terraform-shell-scripts.md) |
| shell deployment scripts | [terraform-shell-scripts.md](./terraform-shell-scripts.md) |
| concurrently / dotenv / globals | [dev-process-tooling.md](./dev-process-tooling.md) |
| markdown / json / html | [dev-process-tooling.md](./dev-process-tooling.md) |