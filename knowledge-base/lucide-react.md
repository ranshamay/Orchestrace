# Lucide React Best Practices

## Overview

`lucide-react` is used for SVG icons. Keep imports tree-shakeable and accessible.

## Best Practices

### Import only used icons

```tsx
import { Play, Pause } from 'lucide-react';
```

### Keep icon sizing consistent

Define shared icon sizing classes (`h-4 w-4`, `h-5 w-5`) and reuse.

### Accessibility

- Decorative icons: `aria-hidden="true"`
- Meaningful icons: `aria-label` or visible text companion

```tsx
<Play aria-hidden="true" className="h-4 w-4" />
```

## Do and Don’t

### Do

- Wrap common icon styles in a small helper component.

### Don’t

- Import the whole library namespace.
- Use icon-only buttons without accessible label.

## Common Pitfalls

- Inconsistent stroke sizes across pages.
- Missing labels on icon buttons.