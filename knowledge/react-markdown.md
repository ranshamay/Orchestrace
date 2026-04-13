# React Markdown Best Practices

`react-markdown` safely renders Markdown to React elements without using `dangerouslySetInnerHTML` by default.

## Installation

```bash
pnpm add react-markdown
```

## Secure Baseline

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownView({ source }: { source: string }) {
  return (
    <article className="prose prose-slate max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </article>
  )
}
```

## Security Guidance

- Default behavior escapes raw HTML; keep that default unless you fully sanitize.
- If enabling raw HTML (`rehype-raw`), also sanitize via `rehype-sanitize` with strict schema.
- Validate/normalize links to avoid `javascript:` URLs.

```tsx
<ReactMarkdown
  components={{
    a: ({ node, href, ...props }) => {
      const safeHref = href?.startsWith('http') || href?.startsWith('/') ? href : '#'
      const external = safeHref?.startsWith('http')
      return (
        <a
          {...props}
          href={safeHref}
          rel={external ? 'noopener noreferrer' : undefined}
          target={external ? '_blank' : undefined}
        />
      )
    },
  }}
>
  {source}
</ReactMarkdown>
```

## Accessibility

- Render within semantic container (`article`).
- Ensure heading order is not skipped when authors control content.
- Provide meaningful link text; avoid bare "click here" patterns.
- Keep code blocks readable with adequate contrast and wrapping.

## Composable Styling

- Use Tailwind Typography (`prose`) as baseline.
- Override individual nodes with `components` for system consistency.

```tsx
<ReactMarkdown
  components={{
    h2: ({ ...props }) => <h2 className="mt-8 text-xl font-semibold" {...props} />,
    code: ({ inline, className, children, ...props }) =>
      inline ? (
        <code className="rounded bg-slate-100 px-1 py-0.5" {...props}>{children}</code>
      ) : (
        <pre className="overflow-x-auto rounded bg-slate-950 p-4 text-slate-100">
          <code className={className} {...props}>{children}</code>
        </pre>
      ),
  }}
>
  {source}
</ReactMarkdown>
```