# HCL (Terraform Syntax) Best Practices

## Overview
HCL (Terraform Syntax) is part of the Orchestrace stack and should be used with explicit conventions so implementation remains reliable, maintainable, and easy to review.

## Why It Matters in This Repo
- Package/technology: `hcl`
- Guide scope: implementation patterns, quality gates, and integration boundaries.
- Audience: implementers, reviewers, and maintainers who need deterministic engineering outcomes.

## Project-Specific Conventions
- Monorepo uses pnpm workspaces with `packages/*` and Turborepo task orchestration.
- Root TypeScript baseline (`tsconfig.base.json`): ES2023 target, ESNext modules, `moduleResolution: bundler`, `strict: true`, `isolatedModules: true`, `verbatimModuleSyntax: true`.
- Root linting (`eslint.config.js`) uses ESLint flat config + `typescript-eslint` recommended preset with relaxed `no-unused-vars` and `no-explicit-any` as warnings.
- Testing baseline (`vitest.config.ts`): `globals: true`, `environment: node`, include `packages/*/tests/**/*.test.ts`, v8 coverage reporters text/json/html.
- UI package uses Vite + React + Tailwind + PostCSS + Autoprefixer, with Vite dev proxy `/api -> http://127.0.0.1:4310` and Tailwind dark mode `class`.
- Prefer readability and explicit intent over clever syntax tricks.
- Keep examples aligned with ESM and strict TypeScript-first development.

## Recommended Workflow
1. Read this guide before implementing changes in files that rely on HCL (Terraform Syntax).
2. Start with the smallest viable change; avoid broad refactors unless required.
3. Run relevant local checks (typecheck, lint, tests) before committing.
4. Keep PR diff focused and include rationale for non-obvious decisions.

## ✅ DO
- Keep code explicit, typed, and easy to reason about.
- Prefer composition over deep inheritance/implicit coupling.
- Write examples and helper utilities that are reusable but not over-generalized.
- Add small comments where business intent is not obvious from code alone.


```ts
// keep integration explicit and typed
export async function executeTask(id: string): Promise<{ id: string; ok: boolean }> {
  if (!id) throw new Error('id is required')
  return { id, ok: true }
}
```

### DO Checklist
- [ ] Inputs validated at boundaries.
- [ ] Errors surfaced with actionable context.
- [ ] Naming matches domain intent.
- [ ] Test coverage added or updated for changed behavior.

## ❌ DON'T
- Don’t bypass established repo conventions “just for this file”.
- Don’t introduce hidden side effects in helpers/utilities.
- Don’t silence lint/type/test failures without root-cause analysis.
- Don’t mix unrelated concerns in one module if boundaries can be cleanly separated.


```ts
// bad: silent failure
try {
  risky()
} catch {}
```

### Anti-Pattern Signals
- Repeated copy/paste logic across modules.
- Unclear ownership of state/data flow.
- “Temporary” code paths left without cleanup tickets.
- Unbounded retries, loops, or expensive operations in hot paths.

## Common Pitfalls
- Over-optimizing before measuring (premature abstraction, premature memoization).
- Ignoring consistency with repo-wide conventions in favor of personal style.
- Skipping lint/type/test checks locally and discovering failures only in CI.
- Leaking secrets or environment-specific values into source control.
- Using broad changes when a targeted, minimal update is safer and easier to review.
- Using HCL (Terraform Syntax) features inconsistently across packages.
- Missing documentation when introducing a new pattern.

## Practical Review Heuristics
- Can a teammate understand this change in <10 minutes?
- Is failure behavior explicit (including partial failure)?
- Are defaults safe, and overrides intentional?
- Is this aligned with existing patterns in nearby modules?

## Incremental Adoption Strategy
- Prefer incremental migration when improving legacy code.
- Add a small adapter layer when integrating new patterns into old modules.
- Document migration notes in PR description for reviewer clarity.

## Reference Commands
```bash
pnpm lint
pnpm typecheck
pnpm test
```

## Definition of Done for HCL (Terraform Syntax) Changes
- Implementation follows this guide’s DO rules.
- Anti-patterns listed here are not introduced.
- Local checks pass; CI failures are addressed before merge.
- Documentation updated if developer workflow or behavior changed.
