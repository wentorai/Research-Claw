// CodeBlock — Markdown code block interceptor with card type detection + syntax highlighting
// Verified against spec 03d §5 + 03e §7.3
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Typography } from 'antd';
import { CopyOutlined, CheckOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import ErrorBoundary from '@/components/ErrorBoundary';
import { CARD_TYPES } from '@/types/cards';
import type {
  PaperCard as PaperCardType,
  TaskCard as TaskCardType,
  ProgressCard as ProgressCardType,
  ApprovalCard as ApprovalCardType,
  FileCard as FileCardType,
  MonitorDigest as MonitorDigestType,
} from '@/types/cards';
import PaperCard from './cards/PaperCard';
import TaskCard from './cards/TaskCard';
import ProgressCard from './cards/ProgressCard';
import ApprovalCard from './cards/ApprovalCard';
import FileCard from './cards/FileCard';
import MonitorDigest from './cards/MonitorDigest';
import CardPlaceholder from './cards/CardPlaceholder';
import { useConfigStore } from '@/stores/config';
import { getThemeTokens } from '@/styles/theme';

const { Text } = Typography;

// ---------------------------------------------------------------------------
// Shiki highlighter singleton (shared module)
// ---------------------------------------------------------------------------

import { getHighlighter } from '@/utils/shiki-highlighter';

// ---------------------------------------------------------------------------
// Syntax-highlighted code block with Copy button
// ---------------------------------------------------------------------------

function SyntaxHighlightedBlock({ language, code }: { language?: string; code: string }) {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Clean up copy timeout on unmount
  useEffect(() => {
    return () => clearTimeout(timeoutRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getHighlighter()
      .then((highlighter) => {
        if (cancelled) return;
        const lang = language && highlighter.getLoadedLanguages().includes(language)
          ? language
          : 'text';
        const result = highlighter.codeToHtml(code, {
          lang,
          theme: theme === 'dark' ? 'github-dark' : 'github-light',
        });
        setHtml(result);
      })
      .catch(() => {
        // Fallback: no highlighting
      });
    return () => { cancelled = true; };
  }, [code, language, theme]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available
    }
  }, [code]);

  return (
    <div
      style={{
        position: 'relative',
        margin: '8px 0',
        borderRadius: 8,
        overflow: 'hidden',
        border: `1px solid ${tokens.border.default}`,
      }}
    >
      {/* Language label + Copy button */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 12px',
          background: tokens.bg.surfaceHover,
          borderBottom: `1px solid ${tokens.border.default}`,
        }}
      >
        <Text style={{ fontSize: 11, color: tokens.text.muted, fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace" }}>
          {language ?? 'text'}
        </Text>
        <Button
          type="text"
          size="small"
          icon={copied ? <CheckOutlined /> : <CopyOutlined />}
          onClick={handleCopy}
          style={{ fontSize: 11, color: tokens.text.muted }}
        >
          {copied ? t('code.copied') : t('code.copy')}
        </Button>
      </div>

      {/* Code content */}
      {html ? (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          style={{
            padding: 12,
            overflow: 'auto',
            fontSize: 13,
            lineHeight: 1.5,
            background: tokens.bg.code,
          }}
        />
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 12,
            overflow: 'auto',
            fontSize: 13,
            fontFamily: "'Fira Code', 'JetBrains Mono', Consolas, monospace",
            lineHeight: 1.5,
            background: tokens.bg.code,
            color: tokens.text.primary,
          }}
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card renderer — maps card type string to the correct component
// ---------------------------------------------------------------------------

function renderCard(cardType: string, data: unknown): React.ReactElement {
  switch (cardType) {
    case 'paper_card':
      return <PaperCard {...(data as PaperCardType)} />;
    case 'task_card':
      return <TaskCard {...(data as TaskCardType)} />;
    case 'progress_card':
      return <ProgressCard {...(data as ProgressCardType)} />;
    case 'approval_card':
      return <ApprovalCard {...(data as ApprovalCardType)} />;
    case 'file_card':
      return <FileCard {...(data as FileCardType)} />;
    case 'monitor_digest':
      return <MonitorDigest {...(data as MonitorDigestType)} />;
    default:
      return <SyntaxHighlightedBlock code={JSON.stringify(data, null, 2)} language="json" />;
  }
}

// ---------------------------------------------------------------------------
// CodeBlock — the react-markdown `components.code` interceptor
// ---------------------------------------------------------------------------

interface CodeBlockProps {
  className?: string;
  children?: React.ReactNode;
}

export default function CodeBlock({ className, children }: CodeBlockProps) {
  const language = className?.replace('language-', '');
  const codeString = String(children).replace(/\n$/, '');

  // 1) Check if the language tag is a known card type
  if (language && CARD_TYPES.has(language)) {
    try {
      const data = JSON.parse(codeString);
      // Guard: only render cards for plain objects, not arrays or primitives
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        return (
          <ErrorBoundary
            fallback={<SyntaxHighlightedBlock language="json" code={codeString} />}
          >
            {renderCard(language, data)}
          </ErrorBoundary>
        );
      }
    } catch {
      // JSON incomplete during streaming — show skeleton instead of raw JSON
      return <CardPlaceholder cardType={language} />;
    }
  }

  // 2) Regular code block — Shiki syntax highlighting + Copy button
  return <SyntaxHighlightedBlock language={language} code={codeString} />;
}
