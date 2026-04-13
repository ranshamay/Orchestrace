# Autoprefixer (Orchestrace UI)

Autoprefixer adds vendor prefixes based on browser compatibility targets during CSS processing.

## Repository Reality

- Configured in `packages/ui/postcss.config.js` as:

```js
autoprefixer: {}
```

- Installed in `packages/ui` devDependencies as `autoprefixer@^10.4.27`.
- Runs as part of the PostCSS pipeline invoked by Vite.

## Practical Guidance

- Keep Autoprefixer enabled for cross-browser resilience.
- Prefer standards-based CSS; let Autoprefixer handle necessary prefixes.
- Use project browser targets (via Browserslist, when defined) to tune output.

## Do / Don’t

### Do

- **Do** keep configuration simple unless there is a concrete browser support need.
- **Do** test critical UI behavior in target browsers after CSS changes.
- **Do** treat generated prefixes as build output, not hand-authored source.

### Don’t

- **Don’t** manually add vendor prefixes in source CSS unless truly unavoidable.
- **Don’t** disable Autoprefixer to shave tiny build time at the expense of compatibility.
- **Don’t** assume prefixes are needed for every property on modern targets.

## Common Pitfalls

- No explicit browser target policy, causing uncertainty about generated prefixes.
- Confusing minification issues with prefixing behavior.
- Overriding defaults without measuring compatibility impact.

## Performance Notes

- Autoprefixer cost is usually small relative to full build; keep it in pipeline.
- Avoid extra CSS tooling that reprocesses the same styles redundantly.
- Leverage Turbo build caching so unchanged CSS avoids repeated work in CI.

## Validation

- Inspect built CSS from `pnpm --filter @orchestrace/ui build`.
- Confirm expected prefixes appear only where compatibility targets require them.