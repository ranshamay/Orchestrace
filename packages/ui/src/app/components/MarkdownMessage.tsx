import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownMessage({ content, dark }: { content: string; dark: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
        ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
        li: ({ children }) => <li className="my-0.5">{children}</li>,
        a: ({ href, children }) => (
          <a className="text-blue-600 underline decoration-blue-300 underline-offset-2 dark:text-blue-300" href={href} rel="noreferrer" target="_blank">
            {children}
          </a>
        ),
        code: ({ children, className }) => {
          const inline = !String(className ?? '').includes('language-');
          if (inline) {
            return (
              <code className={`rounded px-1 py-0.5 font-mono text-[12px] ${dark ? 'bg-slate-800 text-slate-100' : 'bg-slate-100 text-slate-800'}`}>
                {children}
              </code>
            );
          }
          return (
            <code className="block overflow-x-auto whitespace-pre rounded-lg bg-slate-900 p-3 font-mono text-[12px] leading-relaxed text-slate-100">
              {children}
            </code>
          );
        },
        pre: ({ children }) => <pre className="my-2">{children}</pre>,
        blockquote: ({ children }) => (
          <blockquote className={`my-2 border-l-2 pl-3 italic ${dark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`}>
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}