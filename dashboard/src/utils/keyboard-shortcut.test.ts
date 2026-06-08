import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isAbortChatShortcut,
  isMacCommandCAbort,
  isAbortGenerationShortcut,
  isEscapeAbortShortcut,
  abortChatShortcutLabel,
  isMacOS,
  type ShortcutKeyEvent,
} from './keyboard-shortcut';

function keyEvent(overrides: Partial<ShortcutKeyEvent>): ShortcutKeyEvent {
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

  it('rejects Escape with modifiers', () => {
    expect(isEscapeAbortShortcut(keyEvent({ key: 'Escape', ctrlKey: true }))).toBe(false);
  });
});

describe('isAbortChatShortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts Ctrl+C on Windows', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows NT 10.0' });
    expect(isAbortChatShortcut(keyEvent({ ctrlKey: true }))).toBe(true);
  });

  it('accepts Control+C on macOS via getModifierState', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh; Intel Mac OS X' });
    expect(
      isAbortChatShortcut(
        keyEvent({ ctrlKey: false, getModifierState: (k) => k === 'Control' }),
      ),
    ).toBe(true);
  });

  it('accepts Command+. on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    expect(isAbortChatShortcut(keyEvent({ key: '.', code: 'Period', metaKey: true }))).toBe(true);
  });
});

describe('isMacCommandCAbort', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts Command+C when textarea has no selection', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    const textarea = document.createElement('textarea');
    textarea.value = 'hello';
    textarea.selectionStart = textarea.selectionEnd = 5;
    expect(isMacCommandCAbort(keyEvent({ metaKey: true }), textarea)).toBe(true);
  });
});

describe('isAbortGenerationShortcut', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts Escape on any platform', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: '' });
    expect(isAbortGenerationShortcut(keyEvent({ key: 'Escape' }), null)).toBe(true);
  });
});

describe('abortChatShortcutLabel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes Esc on macOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Mac OS X' });
    expect(abortChatShortcutLabel()).toContain('Esc');
  });
});

describe('isMacOS', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses userAgentData.platform when present', () => {
    vi.stubGlobal('navigator', {
      platform: '',
      userAgent: '',
      userAgentData: { platform: 'macOS' },
    });
    expect(isMacOS()).toBe(true);
  });
});
