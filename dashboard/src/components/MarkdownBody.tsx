import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CodeBlock from './chat/CodeBlock';

const markdownComponents = {
  code: ({ className, children, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          style={{
            background: 'var(--surface-active)',
            padding: '2px 4px',
            borderRadius: 3,
            fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
            fontSize: '0.9em',
          }}
          {...props}
        >
          {children}
        </code>
      );
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'var(--accent-secondary)' }}
    >
      {children}
    </a>
  ),
};

interface MarkdownBodyProps {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  /** Tighter spacing for summary cards / description lists */
  compact?: boolean;
}

export default function MarkdownBody({ children, className, style, compact }: MarkdownBodyProps) {
  const classes = [
    'markdown-body',
    compact ? 'markdown-body-compact' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} style={style}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
