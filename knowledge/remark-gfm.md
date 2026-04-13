# Remark GFM Best Practices

`remark-gfm` adds GitHub Flavored Markdown support (tables, task lists, strikethrough, autolinks, footnotes).

## Installation

```bash
pnpm add remark-gfm
```

## Integration with react-markdown

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

<ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
```

## Accessibility

- Task lists should remain understandable to screen readers; consider custom checkbox rendering for richer semantics.
- Ensure markdown tables have clear header rows and avoid overly dense layouts.
- Footnote backlinks and labels should be preserved for keyboard navigation.

## Security

- `remark-gfm` itself is syntax support, not sanitization.
- Continue enforcing link safety and HTML sanitization policy in the rendering layer.

## Composable Styling

- Style GFM features explicitly:
  - `table` with horizontal scrolling.
  - `input[type=checkbox]` with clear focus states.
  - `del` text with accessible contrast.

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    table: ({ ...props }) => (
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse" {...props} />
      </div>
    ),
  }}
>
  {markdown}
</ReactMarkdown>
```