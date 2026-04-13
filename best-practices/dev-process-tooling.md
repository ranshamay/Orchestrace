# Dev Process Tooling Best Practices

This guide documents practical best practices for using **concurrently**, **dotenv**, **globals**, **Markdown**, **JSON**, and **HTML** in this repository.

---

## 1) concurrently

### Overview
Use `concurrently` to run independent long-lived dev processes with clear names/colors and deterministic startup behavior.

### DO
- Name each process with `-n` so logs are readable.
- Use color tags (`-c`) to visually separate streams.
- Gate dependent startup with health checks (e.g., `curl` loop) rather than fixed sleeps.
- Keep commands shell-escaped and test them directly before embedding in `package.json` scripts.
- Prefer one orchestrating script for local “full stack” start.

### DON'T
- Don’t rely on race-prone startup timing (`sleep 2`).
- Don’t run unlabeled concurrent commands in shared logs.
- Don’t hide hard failures behind broad `|| true` unless intentionally non-fatal.
- Don’t duplicate complex startup orchestration across many scripts.

### Configuration
Current root script:
- `package.json` → `scripts.start`
- Uses `concurrently -n 'backend,frontend' -c 'blue,green' ...`
- Backend health-gated before frontend starts via `curl -sf http://127.0.0.1:4310/api/health`

### Project-specific notes
- This repo already uses robust sequencing: backend first, frontend waits for API health.
- Ports are pre-cleared (`lsof ... | xargs kill`) before launch; keep this behavior intentional and documented.

### Example
```json
{
  "scripts": {
    "start": "concurrently -n 'api,ui' -c 'blue,green' 'pnpm api:dev' 'zsh -lc \"until curl -sf http://127.0.0.1:4310/api/health >/dev/null; do sleep 0.2; done; pnpm ui:dev\"'"
  }
}
```

---

## 2) dotenv

### Overview
Use `dotenv` for local developer convenience, but keep runtime behavior deterministic and secure.

### DO
- Load env early in CLI startup.
- Keep `.env` out of source control; maintain `.env.example` for required keys.
- Use explicit fallback precedence and document it.
- Use `quiet: true` when expected in normal operation.
- Validate required env vars before critical operations.

### DON'T
- Don’t commit secrets.
- Don’t spread ad-hoc `dotenv` loads across many files.
- Don’t rely on env vars without clear error messaging.
- Don’t silently overwrite already-set CI/runtime vars.

### Configuration
Current CLI setup (`packages/cli/src/index.ts`):
- `loadDotEnv({ quiet: true });`
- `loadDotEnv({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });`

This implies layered loading for workspace/root scenarios.

### Project-specific notes
- Root has `.env.example`, which should remain the source of truth for expected keys.
- Auth file guidance in README (`ORCHESTRACE_AUTH_FILE`) should stay aligned with env handling behavior.

### Example
```ts
import { config as loadDotEnv } from 'dotenv';

loadDotEnv({ quiet: true });
loadDotEnv({ path: resolve(process.cwd(), '..', '..', '.env'), quiet: true });

if (!process.env.GITHUB_TOKEN) {
  throw new Error('Missing GITHUB_TOKEN. Add it to .env or environment.');
}
```

---

## 3) globals

### Overview
Use globals intentionally by environment (Node vs browser vs test) to reduce lint/test friction and avoid accidental implicit globals.

### DO
- Declare browser globals explicitly in frontend ESLint config.
- Enable Vitest globals consistently across packages if using global test APIs.
- Keep environment-specific configs scoped by file patterns.
- Revisit global usage when migrating between frameworks/tooling.

### DON'T
- Don’t assume browser globals in Node packages.
- Don’t mix inconsistent test styles (`describe` global in one package, imports-only in another) without policy.
- Don’t enable overly broad globals in shared root config.

### Configuration
- Frontend: `packages/ui/eslint.config.js` uses `globals.browser`.
- Tests: multiple `vitest.config.ts` files use `test.globals = true`.

### Project-specific notes
- Root ESLint config is intentionally TS-focused and minimal; browser globals are defined in UI package config, which is correct for monorepo isolation.

### Example
```js
import globals from 'globals';

languageOptions: {
  globals: globals.browser,
}
```

---

## 4) Markdown

### Overview
Use Markdown for human-readable docs and chat rendering, but keep Markdown out of machine-only execution interfaces.

### DO
- Keep docs structured with clear headings and short sections.
- Render user-facing rich text via `react-markdown` in UI components.
- Treat Markdown as untrusted input when crossing into shell/tool execution.
- Enforce explicit guards where Markdown-like payloads must be rejected.

### DON'T
- Don’t pass Markdown/instruction prose into shell command execution.
- Don’t require JSON consumers to parse Markdown fences unless explicitly supported.
- Don’t mix prose and machine payloads in the same contract.

### Configuration
- UI uses `react-markdown` (`packages/ui/src/app/components/MarkdownMessage.tsx`).
- Command guards reject Markdown-like shell payloads (`packages/tools/src/command-tools/guards.ts`).

### Project-specific notes
- This repo explicitly blocks markdown/instructional shell payloads (`validateShellCommandPayload`) to prevent prompt leakage into command execution.
- Preserve this boundary whenever adding new command tools.

### Example
```ts
if (MARKDOWN_LIKE_PAYLOAD.test(normalized)) {
  return {
    ok: false,
    reason: 'Blocked non-command payload: command appears to be markdown/instructional text.',
  };
}
```

---

## 5) JSON

### Overview
JSON is the primary machine contract format for plans, state, artifacts, and API payloads.

### DO
- Use JSON for deterministic machine interfaces (`plan.json`, config, run artifacts).
- Prefer pretty-printed JSON when persisted for human inspection.
- Validate/parse defensively at boundaries.
- Document exact JSON schema/shape for generated outputs.
- Keep content-type checks for HTTP JSON responses.

### DON'T
- Don’t accept malformed JSON silently.
- Don’t require markdown code fences in JSON-only channels.
- Don’t mix free-form text with strict JSON output contracts.

### Configuration
- CLI entry accepts `orchestrace run <plan.json>`.
- Various components parse fenced/unfenced JSON defensively.
- Vitest coverage reporters include `json` and `html`.

### Project-specific notes
- Several prompts already require “valid JSON object, no markdown fences”; keep this rule for machine-consumed outputs.
- Event/store artifacts (`*.json`, `*.jsonl`) are core operational data—treat format stability as a compatibility contract.

### Example
```json
{
  "id": "add-auth",
  "name": "Add authentication",
  "nodes": [
    { "id": "plan", "prompt": "Create implementation plan" }
  ]
}
```

---

## 6) HTML

### Overview
Keep HTML minimal, semantic, and secure; use framework rendering for dynamic UI.

### DO
- Keep `index.html` lean (meta charset/viewport, root mount node, module script).
- Use correct content types when serving HTML (`text/html; charset=utf-8`).
- Prefer component-driven rendering over manual string assembly where possible.
- Escape/sanitize untrusted content before embedding into server-generated HTML.

### DON'T
- Don’t inline large business logic in static HTML.
- Don’t serve HTML with incorrect content types.
- Don’t interpolate untrusted strings directly into HTML templates.

### Configuration
- UI shell: `packages/ui/index.html` (Vite-style mount point).
- Server HTML responses: `packages/cli/src/ui-server.ts` via `sendHtml(...)` with proper content type.

### Project-specific notes
- Since UI is React/Vite-based, keep static HTML as bootstrapping shell only.
- Any server-generated fallback HTML should remain tiny and sanitized.

### Example
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ui</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

## Cross-tooling checklist (recommended for PRs)
- [ ] Concurrency scripts are named, colorized, and dependency-gated.
- [ ] `.env.example` updated for new env vars; no secrets committed.
- [ ] Globals are declared only in the right package/environment configs.
- [ ] Markdown stays in human-facing paths; shell/tool boundaries reject prose.
- [ ] JSON contracts are explicit, parseable, and schema-stable.
- [ ] HTML remains minimal, semantic, and safely served.