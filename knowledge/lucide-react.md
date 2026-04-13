# Lucide React Best Practices

`lucide-react` provides tree-shakeable SVG icon components.

## Installation

```bash
pnpm add lucide-react
```

## Usage

```tsx
import { Search, AlertTriangle } from 'lucide-react'

export function Toolbar() {
  return (
    <div className="flex items-center gap-2">
      <Search className="h-4 w-4" aria-hidden="true" />
      <span>Search</span>
      <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
    </div>
  )
}
```

## Accessibility

- Decorative icon: set `aria-hidden="true"` and do not rely on icon alone.
- Informative icon: provide accessible label via surrounding text or `aria-label`.
- Icon-only buttons must include an accessible name.

```tsx
<button
  type="button"
  aria-label="Open search"
  className="rounded p-2 hover:bg-slate-100 focus-visible:outline"
>
  <Search className="h-4 w-4" aria-hidden="true" />
</button>
```

## Security

- Import icon components statically; avoid dynamic user-controlled imports.
- Do not render raw SVG strings from untrusted sources.

## Styling + Composition

- Prefer inheriting color via `currentColor` and controlling through text color utilities.
- Standardize icon sizing in shared UI primitives (e.g., `h-4 w-4`).
- Compose with `clsx` for stateful color changes.

```tsx
import clsx from 'clsx'
import { CheckCircle } from 'lucide-react'

function StatusIcon({ ok }: { ok: boolean }) {
  return (
    <CheckCircle
      aria-hidden="true"
      className={clsx('h-4 w-4', ok ? 'text-emerald-600' : 'text-slate-400')}
    />
  )
}
```