/**
 * Input history for the chat textarea — terminal-style up/down navigation.
 *
 * Parity reference: openclaw/ui/src/ui/chat/input-history.ts
 * Additions: localStorage persistence, React hook wrapper, getItems() for popup.
 */
import { useCallback, useRef } from 'react';

const MAX = 50;
const STORAGE_KEY = 'rc-input-history';

/**
 * Pure history class — testable without React.
 * Matches OC InputHistory cursor semantics exactly.
 */
export class InputHistory {
  private items: string[] = [];
  private cursor = -1;

  constructor(initial?: string[]) {
    if (initial) {
      this.items = initial.slice(-MAX);
    }
  }

  push(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Deduplicate consecutive identical entries
    if (this.items[this.items.length - 1] === trimmed) return;
    this.items.push(trimmed);
    if (this.items.length > MAX) {
      this.items.shift();
    }
    this.cursor = -1;
  }

  up(): string | null {
    if (this.items.length === 0) return null;
    if (this.cursor < 0) {
      this.cursor = this.items.length - 1;
    } else if (this.cursor > 0) {
      this.cursor--;
    }
    return this.items[this.cursor] ?? null;
  }

  down(): string | null {
    if (this.cursor < 0) return null;
    this.cursor++;
    if (this.cursor >= this.items.length) {
      this.cursor = -1;
      return null;
    }
    return this.items[this.cursor] ?? null;
  }

  reset(): void {
    this.cursor = -1;
  }

  getItems(): string[] {
    return [...this.items];
  }

  getCursor(): number {
    return this.cursor;
  }
}

// ── localStorage helpers ──

function loadFromStorage(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').slice(-MAX) : [];
  } catch {
    return [];
  }
}

function saveToStorage(items: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch { /* storage full — non-fatal */ }
}

// ── React hook ──

export interface UseInputHistoryReturn {
  /** Add text to history (call after successful send). */
  push: (text: string) => void;
  /** Navigate backward (ArrowUp). Returns previous text or null if at start. */
  up: () => string | null;
  /** Navigate forward (ArrowDown). Returns next text or null (back to draft). */
  down: () => string | null;
  /** Reset cursor to -1 (call on send, session switch). */
  reset: () => void;
  /** All history items (for popup display). Newest last. */
  items: () => string[];
  /** Current cursor position (-1 = not browsing). */
  cursor: () => number;
}

/**
 * Hook providing terminal-style input history.
 * Persists to localStorage globally (not per-session).
 */
export function useInputHistory(): UseInputHistoryReturn {
  const historyRef = useRef<InputHistory>(new InputHistory(loadFromStorage()));

  const push = useCallback((text: string) => {
    historyRef.current.push(text);
    saveToStorage(historyRef.current.getItems());
  }, []);

  const up = useCallback(() => historyRef.current.up(), []);
  const down = useCallback(() => historyRef.current.down(), []);
  const reset = useCallback(() => historyRef.current.reset(), []);
  const items = useCallback(() => historyRef.current.getItems(), []);
  const cursor = useCallback(() => historyRef.current.getCursor(), []);

  return { push, up, down, reset, items, cursor };
}
