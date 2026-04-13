# tailwind-merge Best Practices

`tailwind-merge` deduplicates and resolves conflicting Tailwind utility classes.

## Installation

```bash
pnpm add tailwind-merge
```

## Why Use It

When combining base + variant + consumer overrides, conflicts are common:

```ts
'text-sm text-lg' // conflicting
```

`twMerge` keeps the last relevant class:

```ts
import { twMerge } from 'tailwind-merge'

twMerge('text-sm text-lg') // => 'text-lg'
```

## Standard `cn` Helper

```ts
import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs))
}
```

## Accessibility

- Be careful when allowing overrides that might remove focus or contrast classes.
- In critical components, enforce non-overridable accessibility classes in final merge position.

## Security

- `twMerge` is not an input sanitizer.
- Only merge trusted class tokens from code-controlled sources.

## Composable Pattern

```tsx
function Button({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex h-10 items-center rounded-md px-4 focus-visible:outline focus-visible:outline-2',
        className
      )}
      {...props}
    />
  )
}
```

Use this pattern consistently across primitives to support safe overrides without class drift.