# Styling Utilities Best Practices (CVA, clsx, tailwind-merge)

## Overview

`class-variance-authority`, `clsx`, and `tailwind-merge` should be used together to build a consistent variant system.

## Core Pattern

```ts
import { cva } from 'class-variance-authority';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: Array<string | false | null | undefined>) {
  return twMerge(clsx(inputs));
}

export const buttonVariants = cva(
  'inline-flex items-center rounded-md text-sm font-medium',
  {
    variants: {
      intent: {
        primary: 'bg-blue-600 text-white hover:bg-blue-700',
        ghost: 'bg-transparent hover:bg-neutral-100',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4',
      },
    },
    defaultVariants: { intent: 'primary', size: 'md' },
  }
);
```

## Best Practices

- Keep variants domain-based (`intent`, `size`, `tone`) not implementation-based.
- Use `compoundVariants` for cross-variant styling rules.
- Keep `className` override last and merged via `cn`.

## Do and Don’t

### Do

```tsx
<button className={cn(buttonVariants({ intent, size }), className)} />
```

### Don’t

```tsx
// conflicts and duplicates are unmanaged
<button className={`${base} ${intentClass} ${sizeClass} ${className}`} />
```

## Common Pitfalls

- Forgetting to merge class conflicts (`px-2` vs `px-4`).
- Variant explosion due to poor naming.
- Using CVA for one-off elements with no reuse value.