# UI Utilities Best Practices

## Overview

This guide defines practical standards for common UI utilities used in React + Tailwind projects:

- **Lucide React** for icons
- **React Markdown** for rendering markdown safely
- **Remark GFM** for GitHub Flavored Markdown support
- **Class Variance Authority (CVA)** for variant-driven styling
- **clsx** for conditional class composition
- **tailwind-merge** for conflict-free Tailwind class merging

Use these utilities together to keep components readable, consistent, and easy to maintain.

---

## Key Principles

1. **Prefer declarative APIs over ad-hoc string logic**.
2. **Centralize styling decisions** (variants, defaults, state styles).
3. **Merge classes deterministically** to avoid hidden Tailwind conflicts.
4. **Render user content safely** (especially markdown).
5. **Keep utility usage composable** so components stay small and predictable.

---

## Best Practices

### 1) Lucide React

#### ✅ DO

```tsx
import { Loader2, Settings } from "lucide-react";

export function SettingsButton({ loading = false }: { loading?: boolean }) {
  return (
    <button className="inline-flex items-center gap-2 rounded-md border px-3 py-2">
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Settings className="h-4 w-4" aria-hidden="true" />
      )}
      <span>Settings</span>
    </button>
  );
}
```

#### ❌ DON'T

```tsx
import * as Icons from "lucide-react"; // pulls everything, harder to tree-shake

export function Bad() {
  const Icon = Icons["Settings"];
  return <Icon size={17} color="#666" />; // hard-coded style tokens
}
```

---

### 2) React Markdown + Remark GFM

#### ✅ DO

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownView({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="noreferrer noopener" className="underline" />
        ),
        code: ({ node, className, ...props }) => (
          <code {...props} className={`rounded bg-muted px-1 py-0.5 ${className ?? ""}`} />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
```

#### ❌ DON'T

```tsx
export function UnsafeMarkdown({ content }: { content: string }) {
  return <div dangerouslySetInnerHTML={{ __html: content }} />; // unsafe for untrusted content
}
```

> `remark-gfm` enables useful markdown features like tables, task lists, and strikethrough. Keep it explicit in `remarkPlugins`.

---

### 3) Class Variance Authority (CVA)

#### ✅ DO

```tsx
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors",
  {
    variants: {
      intent: {
        primary: "bg-blue-600 text-white hover:bg-blue-500",
        secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200",
      },
      size: {
        sm: "h-8 px-3",
        md: "h-10 px-4",
      },
    },
    defaultVariants: {
      intent: "primary",
      size: "md",
    },
  }
);

type ButtonVariants = VariantProps<typeof buttonVariants>;
```

#### ❌ DON'T

```tsx
// Variant logic spread across components and conditionals
const className =
  "rounded-md " +
  (primary ? "bg-blue-600 text-white " : "bg-gray-100 text-black ") +
  (small ? "h-8 px-3" : "h-10 px-4");
```

---

### 4) clsx

#### ✅ DO

```tsx
import { clsx } from "clsx";

const className = clsx(
  "rounded-md border px-3 py-2",
  isActive && "border-blue-500",
  disabled && "opacity-50 cursor-not-allowed"
);
```

#### ❌ DON'T

```tsx
const className = `rounded-md border px-3 py-2 ${
  isActive ? "border-blue-500" : ""
} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`;
```

---

### 5) tailwind-merge (with clsx)

#### ✅ DO

```tsx
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Usage:
// cn("px-2 py-1", isLarge && "px-4", className)
```

#### ❌ DON'T

```tsx
// Conflicting classes may produce unexpected output
const className = "px-2 py-1 " + (isLarge ? "px-4" : "") + " " + props.className;
```

---

## Common Mistakes

- Importing icon libraries with wildcard imports and increasing bundle size.
- Rendering markdown as raw HTML for convenience.
- Enabling raw HTML parsing for untrusted markdown without sanitization.
- Scattering variant rules across multiple components instead of CVA.
- Using `clsx` without `tailwind-merge`, leaving unresolved class conflicts.
- Re-defining `cn()` utility in multiple files instead of one shared utility.

---

## Checklist

- [ ] Icon imports are named and minimal (`{ IconName }`), not wildcard imports.
- [ ] Icons use semantic sizing/styling classes and proper accessibility attributes.
- [ ] Markdown rendering uses `react-markdown` with `remark-gfm`.
- [ ] Untrusted markdown is not rendered via `dangerouslySetInnerHTML`.
- [ ] CVA is used for component variants and includes `defaultVariants`.
- [ ] Variant types are exported with `VariantProps<typeof ...>` when useful.
- [ ] Conditional classes use `clsx`.
- [ ] Tailwind classes are merged with `tailwind-merge` (prefer shared `cn()` utility).
- [ ] Class name composition avoids manual string concatenation.