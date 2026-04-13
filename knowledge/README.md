# Technology Best Practices Knowledge Base

This folder contains expert-level best-practices guidance for the Orchestrace technology stack.

Use these guides as implementation references for architecture, coding standards, testing, operations, and tooling decisions across the monorepo.

## Languages & Runtime

- [TypeScript](./typescript.md)
- [JavaScript](./javascript.md)
- [Node.js](./nodejs.md)
- [HTML](./html.md)
- [CSS](./css.md)
- [Shell](./shell.md)
- [HCL (Terraform)](./hcl-terraform.md)
- [Markdown](./markdown.md)
- [JSON](./json.md)

## Monorepo & Build

- [pnpm workspaces](./pnpm-workspaces.md)
- [Turborepo](./turborepo.md)
- [Vite](./vite.md)
- [PostCSS](./postcss.md)
- [Autoprefixer](./autoprefixer.md)

## React Ecosystem

- [React](./react.md)
- [React DOM](./react-dom.md)
- [React Router DOM](./react-router-dom.md)
- [@vitejs/plugin-react](./vitejs-plugin-react.md)

## UI Utilities

- [Tailwind CSS](./tailwindcss.md)
- [Lucide React](./lucide-react.md)
- [React Markdown](./react-markdown.md)
- [Remark GFM](./remark-gfm.md)
- [Class Variance Authority](./class-variance-authority.md)
- [clsx](./clsx.md)
- [tailwind-merge](./tailwind-merge.md)

## Testing

- [Vitest](./vitest.md)
- [Playwright / @playwright/test](./playwright.md)

## Linting & Formatting

- [ESLint](./eslint.md)
- [typescript-eslint](./typescript-eslint.md)
- [eslint-plugin-react-hooks](./eslint-plugin-react-hooks.md)
- [eslint-plugin-react-refresh](./eslint-plugin-react-refresh.md)
- [Prettier](./prettier.md)

## Type Tooling & Dev Execution

- [tsx](./tsx.md)
- [Type Definitions (@types/node, @types/react, @types/react-dom)](./type-definitions.md)
- [globals](./globals.md)

## AI & Token Tooling

- [@mariozechner/pi-ai](./pi-ai.md)
- [js-tiktoken](./js-tiktoken.md)

## Infra & Deployment

- [Terraform](./terraform.md)
- [Shell deployment scripts](./shell-deployment.md)

## Dev/Process Tooling

- [concurrently](./concurrently.md)
- [dotenv](./dotenv.md)

---

### Usage Notes

- Prefer patterns that are deterministic, testable, and explicit.
- Keep examples aligned with strict TypeScript and ESM module usage.
- Update these guides when dependencies or major runtime assumptions change.