# React Markdown & Remark GFM Best Practices

## Overview

The UI uses `react-markdown` with `remark-gfm` for tables, task lists, and GitHub-flavored markdown syntax.

## Safe Baseline

```tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

<ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
```

## Best Practices

- Treat markdown input as untrusted.
- Prefer explicit component overrides for links/code blocks.
- Restrict or sanitize raw HTML if enabled.

### Component override example

```tsx
<ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
    code: ({ className, children }) => (
      <code className={`rounded bg-neutral-100 px-1 ${className ?? ''}`}>{children}</code>
    ),
  }}
>
  {content}
</ReactMarkdown>
```

## Do and Don’t

### Do

- Add truncation/virtualization strategy for very large markdown payloads.

### Don’t

- Render unsanitized raw HTML from external sources.

## Common Pitfalls

- XSS risks from unsafe HTML rendering.
- Poor typography/readability without markdown-specific styles.