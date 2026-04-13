# CSS Best Practices

CSS should be predictable, composable, and cheap to maintain.

## Core Principles

- Prefer low-specificity selectors and component-scoped styles.
- Use design tokens (variables) for spacing, colors, and typography.
- Build responsive layouts with flex/grid first.

## Do / Don't

### 1) Keep specificity low

```css
/* ✅ Do */
.card-title {
  font-size: var(--font-size-lg);
}
```

```css
/* ❌ Don't */
#app .dashboard .card .header h3.title {
  font-size: 20px !important;
}
```

### 2) Use logical, reusable spacing

```css
/* ✅ Do */
.stack > * + * {
  margin-block-start: var(--space-3);
}
```

```css
/* ❌ Don't */
.item1 { margin-top: 12px; }
.item2 { margin-top: 12px; }
.item3 { margin-top: 12px; }
```

### 3) Respect user preferences

```css
/* ✅ Do */
@media (prefers-reduced-motion: reduce) {
  * {
    animation: none !important;
    transition: none !important;
  }
}
```

```css
/* ❌ Don't */
.spinner { animation: spin 200ms linear infinite; }
```

## Pitfalls

- Overusing `!important` instead of fixing cascade architecture.
- Hard-coded pixel values without scalable system.
- Layout hacks where grid/flex solves the problem directly.

## Performance Notes

- Avoid expensive selectors and frequent layout thrashing patterns.
- Animate `transform` and `opacity` when possible.
- Minimize large repaints from fixed backgrounds and heavy filters.

## Practical Checklist

- [ ] Tokens used for common values.
- [ ] Selector specificity stays low.
- [ ] Responsive behavior tested at key breakpoints.
- [ ] Motion has reduced-motion fallback.