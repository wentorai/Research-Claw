import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isAbortGenerationShortcut,
  isEscapeAbortShortcut,
  abortChatShortcutLabel,
  type ShortcutKeyEvent,
} from './keyboard-shortcut';

function keyEvent(overrides: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: 'c',
    code: 'KeyC',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe('isEscapeAbortShortcut', () => {
  it('accepts Escape alone', () => {
    expect(isEscapeAbortShortcut(keyEvent({ key: 'Escape', code: '' }))).toBe(true);
  });

  it('rejects Escape with any modifier', () => {
    expect(isEscapeAbortShortcut(keyEvent({ key: 'Escape', ctrlKey: true }))).toBe(false);
    expect(isEscapeAbortShortcut(keyEvent({ key: 'Escape', metaKey: true }))).toBe(false);
    expect(isEscapeAbortShortcut(keyEvent({ key: 'Escape', altKey: true }))).toBe(false);
    expect(isEscapeAbortShortcut(keyEvent({ key: 'Escape', shiftKey: true }))).toBe(false);
  });
});

describe('isAbortGenerationShortcut — Escape ONLY', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts Escape on any platform', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' });
    expect(isAbortGenerationShortcut(keyEvent({ key: 'Escape', code: '' }))).toBe(true);
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    expect(isAbortGenerationShortcut(keyEvent({ key: 'Escape', code: '' }))).toBe(true);
  });

  // Regression guards: these combos used to abort and collided with copy
  // (the selection guard only covered input/textarea targets, so copying
  // streamed assistant text killed the run). They must NEVER abort again.
  it('does NOT abort on Ctrl+C (Windows/Linux copy)', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows NT 10.0' });
    expect(isAbortGenerationShortcut(keyEvent({ ctrlKey: true }))).toBe(false);
  });

  it('does NOT abort on macOS Control+C via getModifierState', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    expect(
      isAbortGenerationShortcut(
        keyEvent({ ctrlKey: false, getModifierState: (k) => k === 'Control' }),
      ),
    ).toBe(false);
  });

  it('does NOT abort on macOS Command+C (copy)', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    expect(isAbortGenerationShortcut(keyEvent({ metaKey: true }))).toBe(false);
  });

  it('does NOT abort on macOS Command+.', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    expect(
      isAbortGenerationShortcut(keyEvent({ key: '.', code: 'Period', metaKey: true })),
    ).toBe(false);
  });

  it('does NOT abort on a plain "c" keypress', () => {
    expect(isAbortGenerationShortcut(keyEvent())).toBe(false);
  });
});

describe('abortChatShortcutLabel', () => {
  it('shows exactly Esc on all platforms (hover copy must match the listener)', () => {
    expect(abortChatShortcutLabel()).toBe('Esc');
  });
});
