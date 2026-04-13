# Tailwind CSS, PostCSS, Autoprefixer, and CSS Best Practices

## Overview

This project uses Tailwind CSS v3 + PostCSS + Autoprefixer in `packages/ui`:

- `packages/ui/tailwind.config.js`
- `packages/ui/postcss.config.js`
- `packages/ui/src/index.css`

Current setup is intentionally lean:

- Tailwind directives: `@tailwind base; @tailwind components; @tailwind utilities;`
- `darkMode: 'class'`
- Content scanning: `./index.html` and `./src/**/*.{js,ts,jsx,tsx}`
- PostCSS plugins: `tailwindcss`, `autoprefixer`

Goal: keep styles predictable, composable, and tree-shakeable while allowing targeted custom CSS (animations, interaction states, and browser-specific behavior).

---

## DO

- **Prefer Tailwind utilities for day-to-day styling** (layout, spacing, typography, color, state variants).
- **Keep design tokens in Tailwind theme extension** (`theme.extend`) instead of hardcoding values repeatedly.
- **Use semantic component wrappers in React**, and keep utility classes close to the component they style.
- **Use `clsx` + `tailwind-merge` for conditional classes** to avoid conflicting utility combinations.
- **Centralize global CSS only for true globals**:
  - custom keyframes
  - browser behavior overrides
  - cross-component animation classes
- **Use `darkMode: 'class'` consistently** by toggling a root class (`html`/`body` app shell), not ad-hoc per component logic.
- **Scope Tailwind `content` globs tightly** so generated CSS stays small and build times stay fast.
- **Let Autoprefixer handle prefixes**; write standard CSS first.
- **Use motion-safe patterns** for heavy animation (`motion-safe:` / reduced-motion fallbacks where applicable).
- **Keep CSS specificity low**; prefer utility composition over `!important`.

---

## DON'T

- **Don’t put large component styling blocks in global CSS** when utilities can express them.
- **Don’t add vendor-prefixed rules manually** unless you have a verified edge case Autoprefixer misses.
- **Don’t use overly broad Tailwind content globs** (like entire monorepo) that bloat CSS output.
- **Don’t mix contradictory utilities** (`p-2 p-4`, `flex grid`) without intentional override handling.
- **Don’t introduce custom CSS classes with unclear ownership** (global leaks, hidden coupling).
- **Don’t rely on runtime-generated class names** that Tailwind cannot statically detect.
- **Don’t disable purge/content scanning safety** by adding broad safelists without concrete need.

---

## Configuration Best Practices

### 1) Tailwind config

Current:

```js
// packages/ui/tailwind.config.js
export default {
  darkMode: 'class',
  plugins: [],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
}
```

Recommended evolution:

```js
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f5f8ff',
          500: '#3b82f6',
          700: '#1d4ed8',
        },
      },
      spacing: {
        18: '4.5rem',
      },
      keyframes: {
        // Prefer defining reusable keyframes here when tied to utilities
      },
      animation: {
        // e.g. 'pulse-soft': 'pulse 2s ease-in-out infinite'
      },
    },
  },
  plugins: [],
}
```

### 2) PostCSS config

Current setup is correct and minimal:

```js
// packages/ui/postcss.config.js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

Best practice:

- Keep plugin chain minimal unless you have a clear need.
- Add new PostCSS plugins only when they solve repeated, proven pain.

### 3) CSS entrypoint

Current global entry (`packages/ui/src/index.css`) correctly starts with Tailwind layers and then custom global rules.

If global CSS grows, organize by sections:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Base global behavior */
/* Shared keyframes */
/* Shared animation helper classes */
```

---

## Project-Specific Notes

- The UI package already includes several animation keyframes/classes in `src/index.css` (graph animations). This is a valid use of global CSS because these behaviors are shared and not simple one-off utilities.
- `darkMode: 'class'` is configured; ensure theme toggling applies the class at a single root boundary for consistent styling.
- Dependency set (`clsx`, `tailwind-merge`, `class-variance-authority`) supports scalable class composition. Prefer these over hand-built class concatenation.
- Keep all Tailwind-using files inside the configured content paths. If styles appear “missing,” check file location and extension first.

---

## Examples

### Example A: Safe class composition in React

```tsx
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs: Array<string | false | null | undefined>) {
  return twMerge(clsx(inputs))
}

export function Button({ primary = false }: { primary?: boolean }) {
  return (
    <button
      className={cn(
        'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors',
        primary
          ? 'bg-blue-600 text-white hover:bg-blue-700'
          : 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200',
      )}
    >
      Click
    </button>
  )
}
```

### Example B: Prefer utility-first before custom class

```tsx
// Good: co-located, readable utility usage
<div className="grid gap-3 rounded-lg border border-zinc-200 p-4 shadow-sm" />
```

```css
/* Avoid for one-off component styling unless reused broadly */
.card {
  display: grid;
  gap: 0.75rem;
  border: 1px solid #e4e4e7;
  border-radius: 0.5rem;
  padding: 1rem;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
```

### Example C: Shared animation in global CSS

```css
@keyframes graph-node-enter {
  from { opacity: 0; transform: scale(0.85); }
  to { opacity: 1; transform: scale(1); }
}

.graph-node-enter {
  animation: graph-node-enter 0.4s ease-out both;
}
```

Use with utilities:

```tsx
<div className="graph-node-enter rounded-md bg-zinc-900/90 p-2 text-white" />
```

### Example D: Dark mode class strategy

```tsx
// Apply once at app/root boundary
document.documentElement.classList.toggle('dark', isDark)
```

Then use Tailwind dark variants normally:

```tsx
<div className="bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100" />
```

---

## Quick Review Checklist

- Tailwind utilities first, global CSS second.
- No unnecessary vendor prefixes (Autoprefixer handles them).
- Content globs are narrow and accurate.
- Shared animations/global rules are intentional and documented.
- Class composition uses `clsx` + `tailwind-merge` for conflict safety.
- Dark mode is controlled via root class, not scattered logic.