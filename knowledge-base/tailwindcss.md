# Tailwind CSS Best Practices

## Overview

The UI uses Tailwind CSS (`packages/ui/tailwind.config.js`) with class-based dark mode.

## Configuration Best Practices

```js
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

## Best Practices

- Prefer utility classes over ad-hoc CSS files.
- Use semantic component wrappers when class lists become complex.
- Keep design tokens in `theme.extend`.
- Use mobile-first breakpoints.

### Good pattern

```tsx
<button className="inline-flex items-center rounded-md px-3 py-2 text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800" />
```

### Extract repeated patterns

Use reusable components or CVA variant helpers rather than `@apply` everywhere.

## Do and Don’t

### Do

- Keep class names static when possible for proper detection.
- Combine with `tailwind-merge` for conflict resolution.

### Don’t

- Build fully dynamic class strings that tooling cannot detect.
- Mix conflicting utilities without merge strategy.

## Common Pitfalls

- Missing content globs causing classes to be purged.
- Overly long class lists without abstraction.
- Inconsistent dark mode handling across components.