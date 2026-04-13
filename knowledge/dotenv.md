# dotenv Best Practices

## Why use dotenv

Use `dotenv` to load environment variables from files in a predictable, local-first way for development and scripting.

## Env layering strategy

Define a clear precedence model and apply it consistently.

Common pattern:
1. Base defaults: `.env`
2. Developer/local overrides: `.env.local`
3. Environment-specific files when needed: `.env.development`, `.env.test`, `.env.production`
4. Real runtime/CI secrets from host environment (preferred for production)

Example loading in scripts:

```json
{
  "scripts": {
    "dev": "dotenv -e .env -e .env.local -- pnpm start",
    "test": "dotenv -e .env.test -- vitest run"
  }
}
```

Guidelines:
- Keep precedence explicit in command order.
- Do not rely on implicit shell exports from prior commands.
- Use environment-specific files only when behavior must differ.

## Secret hygiene

- Commit only safe templates, e.g. `.env.example`.
- Never commit real credentials, tokens, private keys, or prod endpoints containing secrets.
- Add local secret files to `.gitignore` (typically `.env.local`, `.env.*.local`).
- Rotate credentials immediately if leaked.
- Prefer secret managers/CI variables for non-local environments.

Recommended file policy:
- `.env.example`: committed, non-secret placeholders.
- `.env`: optional committed defaults only if truly non-sensitive.
- `.env.local`: uncommitted, developer-specific values.

## Validation and fail-fast

Loading env is not enough; validate required keys at startup.

```ts
const required = ["DATABASE_URL", "API_BASE_URL"];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}
```

Best practices:
- Validate once during app boot.
- Fail fast with clear missing-key errors.
- Keep naming consistent (UPPER_SNAKE_CASE).

## Using dotenv with concurrently

When multiple processes need the same env layering, apply dotenv per process:

```json
{
  "scripts": {
    "dev": "concurrently -k --names api,web \"dotenv -e .env -e .env.local -- pnpm dev:api\" \"dotenv -e .env -e .env.local -- pnpm dev:web\""
  }
}
```

This keeps each child process deterministic and independent.

## Anti-patterns

- Treating `.env` as a secret store in production.
- Sharing personal `.env.local` files.
- Using inconsistent key names across packages.
- Relying on undocumented override order.