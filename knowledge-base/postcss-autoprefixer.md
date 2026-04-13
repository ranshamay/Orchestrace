# PostCSS & Autoprefixer Best Practices

## Overview

The UI PostCSS pipeline is simple and correct:

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

## Best Practices

- Keep plugin order: `tailwindcss` then `autoprefixer`.
- Let Browserslist policy drive prefixing behavior.
- Avoid adding heavyweight PostCSS transforms unless necessary.
- Keep CSS transformations deterministic for reproducible builds.

## Do and Don’t

### Do

- Document any added plugin and why it is needed.
- Verify generated CSS in CI after pipeline changes.

### Don’t

- Add overlapping transforms that conflict with Vite/Tailwind.
- Assume prefixes are needed if target browsers don’t require them.

## Common Pitfalls

- Wrong plugin order producing unexpected CSS.
- Hidden differences between local and CI browserslist configuration.