/**
 * Floating popup for browsing input history.
 * Positioning follows SlashCommandMenu pattern (absolute, bottom: 100%).
 * Anchored to the right side near the send button.
 */
import React, { useEffect, useRef } from 'react';
import { Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';

interface InputHistoryPopupProps {
  /** History items (newest last — displayed in reverse). */
  items: string[];
  /** Whether the popup is visible. */
  visible: boolean;
  /** Called when user selects an item. */
  onSelect: (text: string) => void;
  /** Called to dismiss the popup (Escape, click outside). */
  onDismiss: () => void;
}

export default function InputHistoryPopup({
  items,
  visible,
  onSelect,
  onDismiss,
}: InputHistoryPopupProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss on Escape key
  useEffect(() => {
    if (!visible) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => document.removeEventListener('keydown', handleKey, true);
  }, [visible, onDismiss]);

  // Dismiss on click outside
  useEffect(() => {
    if (!visible) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    // Use setTimeout to avoid the click that opened the popup from immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [visible, onDismiss]);

  if (!visible) return null;

  // Display newest first
  const reversed = [...items].reverse();

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label={t('chat.inputHistoryTitle', { defaultValue: 'Input History' })}
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        width: 340,
        maxHeight: 300,
        marginBottom: 4,
        overflowY: 'auto',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        zIndex: 10,
        padding: '4px 0',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '6px 12px',
          fontSize: 12,
          color: 'var(--text-tertiary)',
          borderBottom: '1px solid var(--border)',
          userSelect: 'none',
        }}
      >
        {t('chat.inputHistoryTitle', { defaultValue: 'Input History' })}
      </div>

      {reversed.length === 0 ? (
        <div
          style={{
            padding: '16px 12px',
            fontSize: 13,
            color: 'var(--text-tertiary)',
            textAlign: 'center',
          }}
        >
          {t('chat.inputHistoryEmpty', { defaultValue: 'No history yet' })}
        </div>
      ) : (
        reversed.map((text, idx) => {
          // Only show tooltip for text that would be truncated
          const needsTooltip = text.length > 40;
          const item = (
            <div
              key={`${idx}-${text.slice(0, 20)}`}
              role="option"
              // Use onMouseDown (not onClick) so it fires before textarea blur
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(text);
              }}
              style={{
                padding: '8px 12px',
                fontSize: 13,
                color: 'var(--text-primary)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                borderBottom: idx < reversed.length - 1 ? '1px solid var(--border)' : 'none',
                transition: 'background 0.1s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'var(--surface-hover)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              {text}
            </div>
          );
          return needsTooltip ? (
            <Tooltip
              key={`tip-${idx}`}
              title={<span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: 400, display: 'block' }}>{text}</span>}
              placement="right"
              overlayStyle={{ maxWidth: 420 }}
              mouseEnterDelay={0.4}
            >
              {item}
            </Tooltip>
          ) : item;
        })
      )}

      {/* Keyboard shortcut tip */}
      <div
        style={{
          padding: '6px 12px',
          fontSize: 11,
          color: 'var(--text-tertiary)',
          borderTop: '1px solid var(--border)',
          userSelect: 'none',
        }}
      >
        {t('chat.inputHistoryTip', { defaultValue: 'Tip: Press ↑↓ in the input box to quickly browse history' })}
      </div>
    </div>
  );
}
