// CardPlaceholder — skeleton shown while a card's JSON is still streaming
import React from 'react';
import { useConfigStore } from '@/stores/config';
import { getThemeTokens } from '@/styles/theme';

const CARD_LABELS: Record<string, string> = {
  paper_card: 'Paper',
  task_card: 'Task',
  progress_card: 'Progress',
  approval_card: 'Approval',
  radar_digest: 'Radar',
  file_card: 'File',
  monitor_digest: 'Monitor',
};

interface CardPlaceholderProps {
  cardType: string;
}

export default function CardPlaceholder({ cardType }: CardPlaceholderProps) {
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const label = CARD_LABELS[cardType] ?? cardType;

  return (
    <div
      data-testid="card-placeholder"
      style={{
        background: tokens.bg.surface,
        border: `1px solid ${tokens.border.default}`,
        borderRadius: 8,
        padding: 16,
        margin: '8px 0',
        maxWidth: 560,
      }}
    >
      {/* Header skeleton */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: tokens.text.muted,
            animation: 'pulse 1.5s ease-in-out infinite',
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: tokens.text.muted,
            fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
          }}
        >
          {label}
        </span>
      </div>

      {/* Content skeleton lines */}
      {[100, 75, 50].map((width, i) => (
        <div
          key={i}
          style={{
            height: 12,
            width: `${width}%`,
            borderRadius: 4,
            background: tokens.bg.surfaceHover,
            marginBottom: i < 2 ? 8 : 0,
            animation: 'pulse 1.5s ease-in-out infinite',
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </div>
  );
}
