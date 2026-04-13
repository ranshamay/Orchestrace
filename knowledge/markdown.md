# Markdown Best Practices

Markdown should be readable in raw form and consistent across docs.

## Core Principles

- Prefer clear structure over decorative formatting.
- Keep headings hierarchical and predictable.
- Use fenced code blocks with language identifiers.

## Do / Don't

### 1) Use consistent heading levels

```md
<!-- ✅ Do -->
# Guide Title
## Overview
### Example
```

```md
<!-- ❌ Don't -->
# Guide Title
#### Overview
## Example
```

### 2) Provide language tags for code fences

````md
<!-- ✅ Do -->
```ts
export const ok = true;
```
````

````md
<!-- ❌ Don't -->
```
export const ok = true;
```
````

### 3) Prefer descriptive links

```md
<!-- ✅ Do -->
See the [TypeScript guide](./typescript.md).
```

```md
<!-- ❌ Don't -->
Click [here](./typescript.md).
```

## Pitfalls

- Oversized paragraphs that hide key guidance.
- Inconsistent terminology across guides.
- Broken relative links after file moves.

## Performance Notes

- Keep docs focused; split very long pages.
- Reuse shared sections through cross-links instead of duplication.

## Practical Checklist

- [ ] One `#` heading per file.
- [ ] Code fences include language.
- [ ] Lists and tables remain readable on narrow screens.
- [ ] Relative links validated.