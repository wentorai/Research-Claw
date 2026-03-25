import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getSlashCommandCompletions, getCommandDescription } from '../../utils/slash-commands';
import type { SlashCommandDef } from '../../utils/slash-commands';

interface SlashCommandMenuProps {
  /** Filtered commands to display */
  commands: SlashCommandDef[];
  /** Index of the currently active (highlighted) item — single source of truth from hook */
  activeIndex: number;
  /** Called when user selects a command (click) */
  onSelect: (command: SlashCommandDef) => void;
  /** Called when mouse hovers over an item — updates activeIndex in the hook */
  onHover: (index: number) => void;
  /** Whether the menu should be visible */
  visible: boolean;
}

/**
 * Floating autocomplete menu for slash commands.
 * Pure render component — all state is managed by the useSlashCommandMenu hook.
 * Appears above the input when the user types "/" at the start.
 */
export default function SlashCommandMenu({
  commands,
  activeIndex,
  onSelect,
  onHover,
  visible,
}: SlashCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Scroll active item into view
  useEffect(() => {
    if (!menuRef.current) return;
    const items = menuRef.current.querySelectorAll('[data-cmd-item]');
    items[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!visible || commands.length === 0) return null;

  return (
    <div
      ref={menuRef}
      role="listbox"
      style={{
        position: 'absolute',
        bottom: '100%',
        left: 0,
        right: 0,
        marginBottom: 4,
        maxHeight: 240,
        overflowY: 'auto',
        background: 'var(--surface, #1a1a2e)',
        border: '1px solid var(--border, rgba(255,255,255,0.1))',
        borderRadius: 8,
        boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
        zIndex: 100,
        padding: '4px 0',
      }}
    >
      {commands.map((cmd, idx) => {
        const isActive = idx === activeIndex;
        const argHint = cmd.args ? ` ${cmd.args}` : '';
        return (
          <div
            key={cmd.name}
            data-cmd-item
            role="option"
            aria-selected={isActive}
            onMouseEnter={() => onHover(idx)}
            onMouseDown={(e) => {
              // Use mouseDown instead of click to fire before textarea blur
              e.preventDefault();
              onSelect(cmd);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              cursor: 'pointer',
              background: isActive ? 'var(--surface-hover, rgba(255,255,255,0.06))' : 'transparent',
              transition: 'background 0.1s',
            }}
          >
            <span
              style={{
                fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
                fontSize: 13,
                color: 'var(--accent-secondary, #3B82F6)',
                fontWeight: 500,
                flexShrink: 0,
              }}
            >
              /{cmd.name}
              {argHint && (
                <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
                  {argHint}
                </span>
              )}
            </span>
            <span
              style={{
                fontSize: 12,
                color: 'var(--text-secondary, #a1a1aa)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {getCommandDescription(cmd)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Hook: single source of truth for slash command menu state.
 * Returns everything needed for both the SlashCommandMenu component and keyboard handling.
 */
export function useSlashCommandMenu(
  text: string,
  onComplete: (fullCommand: string) => void,
) {
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmed = text.trim();

  // Show menu when:
  // 1. Input starts with "/"
  // 2. Input is a single token (no space = still typing the command name)
  // 3. User hasn't explicitly dismissed (Escape)
  const isSlashPrefix = trimmed.startsWith('/') && !trimmed.includes(' ') && trimmed.length <= 20;
  const visible = isSlashPrefix && !dismissed;

  const filter = isSlashPrefix ? trimmed.slice(1) : '';
  const commands = visible ? getSlashCommandCompletions(filter) : [];

  // Reset dismissed state when "/" prefix goes away (user cleared input)
  useEffect(() => {
    if (!isSlashPrefix) setDismissed(false);
  }, [isSlashPrefix]);

  // Reset active index when filter changes
  useEffect(() => {
    setActiveIndex(0);
  }, [filter]);

  const handleSelect = useCallback(
    (cmd: SlashCommandDef) => {
      const hasArgs = !!cmd.args;
      onComplete(hasArgs ? `/${cmd.name} ` : `/${cmd.name}`);
      setDismissed(true);
    },
    [onComplete],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!visible || commands.length === 0) return false;
      // Don't intercept during IME composition
      if (e.nativeEvent.isComposing || e.keyCode === 229) return false;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => (i + 1) % commands.length);
          return true;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => (i - 1 + commands.length) % commands.length);
          return true;
        case 'Tab':
        case 'Enter':
          e.preventDefault();
          if (commands[activeIndex]) {
            handleSelect(commands[activeIndex]);
          }
          return true;
        case 'Escape':
          e.preventDefault();
          setDismissed(true);
          return true;
        default:
          return false;
      }
    },
    [visible, commands, activeIndex, handleSelect],
  );

  return {
    visible,
    commands,
    activeIndex,
    setActiveIndex,
    handleSelect,
    handleKeyDown,
    dismiss: () => setDismissed(true),
  };
}
