# Class Variance Authority (CVA) Best Practices

CVA provides typed, declarative class variants for component APIs.

## Installation

```bash
pnpm add class-variance-authority
```

## Why CVA

- Centralizes visual variants (intent, size, tone).
- Produces predictable component styling contracts.
- Works well with `clsx` and `tailwind-merge`.

## Pattern

```ts
import { cva, type VariantProps } from 'class-variance-authority'

export const badgeStyles = cva('inline-flex items-center rounded px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-slate-100 text-slate-800',
      success: 'bg-emerald-100 text-emerald-800',
      danger: 'bg-red-100 text-red-800',
    },
  },
  defaultVariants: {
    tone: 'neutral',
  },
})

export type BadgeVariants = VariantProps<typeof badgeStyles>
```

## Accessibility

- Keep variants visual-only; semantic behavior must come from proper elements/ARIA.
- Ensure each variant meets contrast requirements.
- Preserve focus styles across all variants.

## Security

- Expose limited variant enums rather than raw `className` strings from untrusted data.
- Validate external configuration before mapping into variant props.

## Composing with tailwind-merge + clsx

```ts
import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs))
}
```

```tsx
type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & BadgeVariants

export function Badge({ tone, className, ...props }: BadgeProps) {
  return <span className={cn(badgeStyles({ tone }), className)} {...props} />
}
```