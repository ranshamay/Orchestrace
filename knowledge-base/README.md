# Orchestrace Knowledge Base - Technology Best Practices

This directory is the canonical engineering guidance for the Orchestrace stack.
It is written for humans and AI implementers, with repo-specific defaults, practical examples,
what to do and what to avoid.

Use this index to load only the guides relevant to the current task.

## Core Runtime & Monorepo

- [TypeScript](./typescript.md)
- [Node.js](./nodejs.md)
- [pnpm Workspaces](./pnpm-workspaces.md)
- [Turborepo](./turborepo.md)

## Frontend Framework

- [React & React DOM](./react.md)
- [React Router DOM](./react-router-dom.md)
- [Vite & @vitejs/plugin-react](./vite.md)

## Styling

- [Tailwind CSS](./tailwindcss.md)
- [PostCSS & Autoprefixer](./postcss-autoprefixer.md)
- [Styling Utilities (CVA, clsx, tailwind-merge)](./styling-utilities.md)

## UI Libraries

- [Lucide React](./lucide-react.md)
- [React Markdown & Remark GFM](./react-markdown.md)

## Testing

- [Vitest](./vitest.md)
- [Playwright](./playwright.md)

## Linting & Formatting

- [ESLint & typescript-eslint](./eslint.md)
- [Prettier](./prettier.md)

## Type Tooling & Dev Execution

- [TypeScript Advanced Patterns](./typescript-advanced.md)
- [tsx Runner & @types Packages](./tsx-runner.md)

## AI & Token Tooling

- [AI & Token Tooling (@mariozechner/pi-ai, js-tiktoken)](./ai-tooling.md)

## Infrastructure & Deployment

- [Terraform / HCL](./terraform.md)
- [Shell Deployment Scripts](./shell-scripts.md)

## Dev/Process Tooling

- [concurrently & dotenv](./dev-tooling.md)

---

## How to Use This Knowledge Base

1. Pick the task category (e.g., UI, infra, tests).
2. Load only relevant guides to keep context focused.
3. Follow repo-specific rules first (configs and scripts in this repository).
4. Apply Do/Don't sections while implementing.
5. Check Common Pitfalls before final validation.

## Ground Truth References in This Repo

- Root TypeScript base config: `tsconfig.base.json`
- Root lint config: `eslint.config.js`
- Root test config: `vitest.config.ts`
- Monorepo config: `pnpm-workspace.yaml`, `turbo.json`
- UI config: `packages/ui/{vite.config.ts,tailwind.config.js,postcss.config.js,eslint.config.js}`
- Infra config: `infra/terraform/*`, `infra/scripts/deploy-compute.sh`

## Authoring Standard for New Guides

Each guide should include:

- Overview
- Configuration Best Practices (repo-specific)
- Best Practices with realistic examples
- Do and Don’t patterns
- Common Pitfalls and mitigations

Keep recommendations deterministic and implementation-friendly.