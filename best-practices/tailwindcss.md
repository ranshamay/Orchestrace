# Tailwind CSS + PostCSS + Autoprefixer Best Practices

## 1) Scope and baseline

These practices target Tailwind + PostCSS pipelines with:

- `tailwindcss`
- `postcss`
- `autoprefixer`

Goal: keep styles maintainable, predictable, and production-safe as the codebase grows.

---

## 2) Baseline pipeline

```js
// postcss.config.js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

```js
// tailwind.config.js
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

### Why

- Tailwind generates only classes discovered in `content` paths.
- Autoprefixer adds browser-specific prefixes based on project browser targets.

---

## 3) Content scanning and purge safety

### DO

- Keep `content` globs precise and complete.
- Include all template/component locations that emit class names.
- Use `safelist` for dynamic classes that cannot be statically discovered.

```js
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  safelist: ['text-green-600', 'text-red-600'],
}
```

### DON'T

- Don’t build class names from arbitrary runtime string concatenation.

```tsx
// ❌ Can fail purge/scanning
<div className={`text-${status}-600`} />
```

Prefer explicit maps:

```tsx
const statusClass = {
  success: 'text-green-600',
  error: 'text-red-600',
}[status]
```

---

## 4) Design tokens and theme extension

### DO

- Extend `theme` with semantic tokens (`brand`, `surface`, `muted`) instead of hardcoded hex everywhere.
- Centralize spacing/radius/shadow decisions in config.
- Keep naming system-oriented, not page-specific.

```js
theme: {
  extend: {
    colors: {
      brand: {
        50: '#eff6ff',
        600: '#2563eb',
      },
      surface: '#0b1020',
    },
  },
}
```

### DON'T

- Don’t duplicate one-off inline color utilities across many files.

---

## 5) Component styling conventions

### DO

- Compose repeated utility sets into reusable components/helpers.
- Use `clsx` + `tailwind-merge` for conditional variants and conflict resolution.
- Keep utility order consistent for readability.

```tsx
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

function cn(...inputs) {
  return twMerge(clsx(inputs))
}

<button className={cn('px-3 py-2 text-sm font-medium', isPrimary && 'bg-brand-600 text-white')} />
```

### DON'T

- Don’t copy-paste 20+ utility classes across multiple call sites.
- Don’t rely on class order “accidents” to override styles.

---

## 6) Dark mode strategy

### DO

- Use one dark-mode strategy consistently (`darkMode: 'class'` is common for app UIs).
- Toggle a root-level class and test both themes in CI/visual QA.

### DON'T

- Don’t mix class-based and media-query dark mode patterns without clear intent.

---

## 7) PostCSS + Autoprefixer operational rules

### DO

- Keep browser support policy explicit (via Browserslist in `package.json` or dedicated config).
- Let Autoprefixer handle prefixes; write modern CSS first.
- Re-check generated output when adding nonstandard CSS features.

### DON'T

- Don’t manually add vendor prefixes throughout source styles.
- Don’t assume every modern CSS feature is transpiled/polyfilled by PostCSS.

---

## 8) Performance and build hygiene

### DO

- Keep Tailwind plugin usage intentional.
- Remove unused custom plugins/utilities periodically.
- Audit final CSS size in production builds.

### DON'T

- Don’t use overly broad `content` globs that scan irrelevant files/folders.
- Don’t safelist massive utility ranges unless absolutely necessary.

---

## 9) DO / DON'T quick reference

### ✅ DO

- Keep `content` accurate.
- Use semantic design tokens in `theme.extend`.
- Use `clsx` + `tailwind-merge` for conditional styling.
- Let Autoprefixer manage vendor prefixes.
- Test dark + light themes.

### ❌ DON'T

- Generate Tailwind class names dynamically without safelisting.
- Hardcode scattered one-off values instead of shared tokens.
- Depend on manual prefixing.
- Add plugins/utilities without maintenance ownership.

---

## 10) PR review checklist

- [ ] `content` globs still cover all relevant files.
- [ ] Dynamic class use is map-based or safelisted.
- [ ] New visual tokens added in `theme.extend` when reusable.
- [ ] No manual vendor prefixes added unnecessarily.
- [ ] Production CSS size impact is acceptable.