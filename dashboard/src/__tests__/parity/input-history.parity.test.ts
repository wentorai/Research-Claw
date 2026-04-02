/**
 * Behavioral Parity Tests: Input History
 *
 * Verifies that our useInputHistory hook matches OpenClaw's InputHistory class
 * behavior (cursor semantics, dedup, whitespace handling, FIFO eviction).
 *
 * Reference: openclaw/ui/src/ui/chat/input-history.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';

// We test the pure class, not the React hook, for parity verification.
// The hook wraps this class with React state + localStorage persistence.
import { InputHistory } from '../../hooks/useInputHistory';

describe('InputHistory — parity with openclaw/ui/src/ui/chat/input-history.ts', () => {
  let history: InputHistory;

  beforeEach(() => {
    history = new InputHistory();
  });

  describe('push()', () => {
    it('adds trimmed text to items', () => {
      history.push('hello');
      expect(history.getItems()).toEqual(['hello']);
    });

    it('trims whitespace', () => {
      history.push('  hello  ');
      expect(history.getItems()).toEqual(['hello']);
    });

    it('skips empty strings', () => {
      history.push('');
      expect(history.getItems()).toEqual([]);
    });

    it('skips whitespace-only strings', () => {
      history.push('   ');
      history.push('\n\t');
      expect(history.getItems()).toEqual([]);
    });

    it('deduplicates consecutive identical entries', () => {
      history.push('hello');
      history.push('hello');
      expect(history.getItems()).toEqual(['hello']);
    });

    it('allows non-consecutive duplicates', () => {
      history.push('hello');
      history.push('world');
      history.push('hello');
      expect(history.getItems()).toEqual(['hello', 'world', 'hello']);
    });

    it('resets cursor to -1 on push', () => {
      history.push('a');
      history.push('b');
      history.up(); // cursor = 1
      history.push('c');
      // After push, cursor is -1, so up() should return last item
      expect(history.up()).toBe('c');
    });

    it('evicts oldest when exceeding MAX (50)', () => {
      for (let i = 0; i < 55; i++) {
        history.push(`item-${i}`);
      }
      const items = history.getItems();
      expect(items.length).toBe(50);
      expect(items[0]).toBe('item-5'); // first 5 evicted
      expect(items[49]).toBe('item-54');
    });
  });

  describe('up()', () => {
    it('returns null when history is empty', () => {
      expect(history.up()).toBeNull();
    });

    it('returns last item on first up()', () => {
      history.push('a');
      history.push('b');
      history.push('c');
      expect(history.up()).toBe('c');
    });

    it('navigates backward on successive up() calls', () => {
      history.push('a');
      history.push('b');
      history.push('c');
      expect(history.up()).toBe('c');
      expect(history.up()).toBe('b');
      expect(history.up()).toBe('a');
    });

    it('stays at first item when at beginning', () => {
      history.push('a');
      history.push('b');
      history.up(); // b
      history.up(); // a
      expect(history.up()).toBe('a'); // still a
    });
  });

  describe('down()', () => {
    it('returns null when cursor is not active (cursor = -1)', () => {
      history.push('a');
      expect(history.down()).toBeNull();
    });

    it('navigates forward after up()', () => {
      history.push('a');
      history.push('b');
      history.push('c');
      history.up(); // c
      history.up(); // b
      expect(history.down()).toBe('c');
    });

    it('returns null when navigating past newest item (back to draft)', () => {
      history.push('a');
      history.push('b');
      history.up(); // b
      history.up(); // a
      history.down(); // b
      expect(history.down()).toBeNull(); // past end → back to draft
    });

    it('cursor is -1 after navigating past end', () => {
      history.push('a');
      history.up(); // a
      history.down(); // null (past end)
      // Subsequent down() should also return null
      expect(history.down()).toBeNull();
    });
  });

  describe('reset()', () => {
    it('resets cursor so next up() returns last item', () => {
      history.push('a');
      history.push('b');
      history.up(); // b
      history.up(); // a
      history.reset();
      expect(history.up()).toBe('b'); // back to last
    });
  });

  describe('up() + down() round-trip', () => {
    it('full round-trip returns to original position', () => {
      history.push('a');
      history.push('b');
      history.push('c');
      // Go all the way up
      expect(history.up()).toBe('c');
      expect(history.up()).toBe('b');
      expect(history.up()).toBe('a');
      // Come all the way down
      expect(history.down()).toBe('b');
      expect(history.down()).toBe('c');
      expect(history.down()).toBeNull(); // back to draft
    });
  });
});
