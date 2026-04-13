# clsx Best Practices

`clsx` conditionally builds className strings with a tiny API.

## Installation

```bash
pnpm add clsx
```

## Usage

```tsx
import clsx from 'clsx'

const className = clsx(
  'rounded-md px-3 py-2',
  isActive && 'bg-brand-600 text-white',
  disabled ? 'opacity-50' : 'hover:bg-slate-100'
)
```

## Accessibility

- Do not hide focus states conditionally unless replaced with equivalent cues.
- Prefer explicit disabled states that include both visual and semantic behavior.

## Security

- Avoid passing user-provided class fragments directly.
- Use boolean flags and trusted lookup maps for conditional classes.

## Composable Styling

- `clsx` handles conditions; pair with `tailwind-merge` to resolve conflicts.
- Keep class logic near component props for readability.

```ts
import clsx from 'clsx'
import { twMerge } from 'tailwind-merge'

export const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(inputs))
```