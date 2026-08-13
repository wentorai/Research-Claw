import { describe, expect, it } from 'vitest';

import { resolvePanelShortcut } from './panel-shortcut';

const tabs = ['library', 'workspace', 'review', 'tasks', 'monitor'] as const;

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: '1',
    keyCode: 49,
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent;
}

describe('policy-filtered panel shortcuts', () => {
  it('indexes only visible tabs and rejects hidden/out-of-range positions', () => {
    expect(resolvePanelShortcut(keyEvent({ key: '5' }), tabs)).toBe('monitor');
    expect(resolvePanelShortcut(keyEvent({ key: '6' }), tabs)).toBeNull();
  });

  it('ignores CJK IME composition and keyCode 229', () => {
    expect(resolvePanelShortcut(keyEvent({ isComposing: true }), tabs)).toBeNull();
    expect(resolvePanelShortcut(keyEvent({ keyCode: 229 }), tabs)).toBeNull();
  });

  it('requires unmodified Ctrl and a single decimal digit', () => {
    expect(resolvePanelShortcut(keyEvent({ ctrlKey: false }), tabs)).toBeNull();
    expect(resolvePanelShortcut(keyEvent({ metaKey: true }), tabs)).toBeNull();
    expect(resolvePanelShortcut(keyEvent({ shiftKey: true }), tabs)).toBeNull();
    expect(resolvePanelShortcut(keyEvent({ key: 'x' }), tabs)).toBeNull();
  });
});
