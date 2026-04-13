# UI Utilities Best Practices

## Overview

This guide covers best practices for these UI utilities in the `@orchestrace/ui` app:

- `lucide-react` (icons)
- `react-markdown` + `remark-gfm` (Markdown rendering)
- `class-variance-authority` (variant modeling)
- `clsx` (conditional class composition)
- `tailwind-merge` (Tailwind conflict resolution)

Current project state:

- `lucide-react`, `react-markdown`, and `remark-gfm` are actively used.
- `class-variance-authority`, `clsx`, and `tailwind-merge` are installed but not yet used in source.
- Many components currently build complex class strings via template literals.

---

## DO

### lucide-react

- Import only the icons you use from `lucide-react` (tree-shakable named imports).
- Keep icon size/styling consistent (`h-3 w-3`, `h-4 w-4`, etc.) by context.
- Mark decorative icons as hidden from assistive tech.

```tsx
<CheckCircle className="h-4 w-4 text-emerald-500" aria-hidden="true" />
```

- Add an accessible label when icon-only actions are clickable.

```tsx
<button aria-label="Refresh code changes" type="button">
  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
</button>
```

### react-markdown + remark-gfm

- Always provide explicit renderers via `components` for typography and spacing consistency.
- Keep `remarkPlugins={[remarkGfm]}` enabled for tables, task lists, and strikethrough support.
- Keep links secure when opening new tabs (`target="_blank"` + `rel="noreferrer"` or `rel="noopener noreferrer"`).
- Treat markdown as untrusted input by default; only enable raw HTML support if absolutely required and sanitized.

### class-variance-authority / clsx / tailwind-merge

- Standardize class composition through a shared `cn()` helper:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- Use `cva()` for reusable components with variants (`tone`, `size`, `state`), especially where nested ternaries are growing.
- Keep base styles in `cva`, and pass external overrides through `className` + `cn(...)`.

```ts
import { cva } from 'class-variance-authority';

const badge = cva('rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
      success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
      danger: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
```

---

## DON'T

### lucide-react

- Don’t pass meaningful information only through icon color/shape; include text or `aria-label`.
- Don’t mix many arbitrary icon sizes in the same visual region.

### react-markdown + remark-gfm

- Don’t allow dangerous HTML rendering (`rehype-raw`) unless you also sanitize explicitly.
- Don’t skip link hardening for external links.
- Don’t rely on default markdown element styling in Tailwind apps; default browser styles are inconsistent.

### cva / clsx / tailwind-merge

- Don’t keep accumulating long template-literal class expressions with nested conditions.
- Don’t use `clsx` alone when conflicting Tailwind classes may be composed (`px-2` + `px-4`, `bg-*`, etc.).
- Don’t put business logic inside `cva`; keep it focused on visual variants.

---

## Configuration

### 1) Add a shared `cn` utility

Create `packages/ui/src/app/lib/cn.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

### 2) Add typed variants with `cva`

```ts
import { cva, type VariantProps } from 'class-variance-authority';

export const chipVariants = cva('rounded border px-2 py-1 text-xs', {
  variants: {
    status: {
      pending: 'border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100',
      success: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100',
      error: 'border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100',
    },
  },
  defaultVariants: { status: 'pending' },
});

export type ChipVariantProps = VariantProps<typeof chipVariants>;
```

### 3) Markdown safety baseline

Keep this baseline in markdown renderers:

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline">
        {children}
      </a>
    ),
  }}
>
  {content}
</ReactMarkdown>
```

---

## Project-specific notes and examples

### What to refactor first (highest ROI)

The biggest win is replacing complex inline class template strings with `cva` + `cn` in components like:

- `packages/ui/src/app/components/work/TimelineList.tsx`
- `packages/ui/src/app/components/work/ToolChip.tsx`
- `packages/ui/src/app/components/chat/ChatPanel.tsx`
- `packages/ui/src/app/components/settings/SettingsTabView.tsx`

These files contain many conditional Tailwind branches where merge conflicts and readability issues are likely.

### Existing good pattern to preserve

`packages/ui/src/app/components/MarkdownMessage.tsx` already:

- Uses `react-markdown` with `remark-gfm`
- Overrides markdown element renderers
- Uses safe external-link attributes

Keep this as the baseline markdown rendering pattern.

### Example: refactor a status badge

Before (inline ternary-heavy class string):

```tsx
<span className={`rounded px-1.5 py-0.5 ${isError ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'}`}>
  {label}
</span>
```

After (`cva` + `cn`):

```tsx
const statusBadge = cva('rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide', {
  variants: {
    tone: {
      error: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
      success: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
    },
  },
});

<span className={cn(statusBadge({ tone: isError ? 'error' : 'success' }))}>{label}</span>
```

### Example: icon consistency

Use consistent icon sizing by semantic level:

- Micro metadata rows: `h-3 w-3` or `h-3.5 w-3.5`
- Primary action buttons: `h-4 w-4`
- Do not mix `h-3` and `h-5` in same control cluster unless intentional

---

## Team rule of thumb

- If class logic is simple (1–2 toggles): use `cn(...)`.
- If class logic has named variants reused in multiple places: use `cva(...)`.
- If rendering model-generated or user-provided markdown: keep strict markdown config and safe links by default.