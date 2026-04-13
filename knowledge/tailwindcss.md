# Tailwind CSS Best Practices

Tailwind CSS is a utility-first CSS framework that enables fast, consistent UI development.

## Core Principles

- Keep styles in markup for local clarity; extract only repeated patterns.
- Prefer design tokens in `tailwind.config.*` (`theme.extend`) over ad-hoc values.
- Use responsive and state variants (`sm:`, `md:`, `hover:`, `focus-visible:`) intentionally.
- Avoid long class strings by composing with CVA + `clsx` + `tailwind-merge`.

## Integration Setup (Vite + React)

```bash
pnpm add -D tailwindcss postcss autoprefixer
pnpm exec tailwindcss init -p
```

`tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7ff',
          600: '#2563eb',
          700: '#1d4ed8',
        },
      },
    },
  },
  plugins: [],
} satisfies Config
```

`src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

## Accessibility Guidance

- Ensure sufficient color contrast for text/background combinations.
- Always provide visible keyboard focus (`focus-visible:outline-*`).
- Use semantic HTML first (`button`, `nav`, `main`) and style second.
- Pair motion utilities with `motion-reduce:*` variants.

Example:

```tsx
<button
  className="rounded-md bg-brand-600 px-4 py-2 text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 motion-reduce:transition-none"
>
  Continue
</button>
```

## Security Guidance

- Treat Tailwind classes as trusted source code, not user input.
- Do **not** interpolate untrusted user strings into `className`.
- Use explicit maps instead of dynamic template classes:

```ts
const intentClass: Record<'primary' | 'danger', string> = {
  primary: 'bg-brand-600 text-white',
  danger: 'bg-red-600 text-white',
}
```

## Composable Styling Pattern

Recommended utility composition stack:

1. **CVA** defines variants.
2. **clsx** handles conditional toggles.
3. **tailwind-merge** resolves class conflicts.

```ts
import { cva } from 'class-variance-authority'

export const buttonStyles = cva(
  'inline-flex items-center rounded-md px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2',
  {
    variants: {
      intent: {
        primary: 'bg-brand-600 text-white hover:bg-brand-700',
        ghost: 'bg-transparent hover:bg-slate-100',
      },
      size: {
        sm: 'h-8',
        md: 'h-10',
      },
    },
    defaultVariants: {
      intent: 'primary',
      size: 'md',
    },
  }
)
```

## Common Pitfalls

- Missing `content` globs causes purged classes in production.
- Excessive arbitrary values (`w-[317px]`) reduce consistency.
- Overusing `!important` (`!`) makes styles harder to maintain.