import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

describe('early text input context warmup', () => {
  it('loads before the theme script and React module', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const warmup = html.indexOf('/text-input-context-warmup.js?v=3');
    const theme = html.indexOf('/theme-init.js');
    const react = html.indexOf('/src/main.tsx');

    expect(warmup).toBeGreaterThan(-1);
    expect(warmup).toBeLessThan(theme);
    expect(theme).toBeLessThan(react);
  });

  it('installs only pointer/focus capture and synchronously reads textarea state', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'public/text-input-context-warmup.js'),
      'utf8',
    );
    const registrations: Array<[string, EventListener, boolean]> = [];
    const fakeDocument = {
      addEventListener: vi.fn(),
    };
    const fakeWindow: {
      location: { search: string };
      addEventListener: ReturnType<typeof vi.fn>;
      __rcImeProbe?: unknown;
    } = {
      location: { search: '' },
      addEventListener: vi.fn((type: string, listener: EventListener, capture: boolean) => {
        registrations.push([type, listener, capture]);
      }),
    };

    new Function('window', 'document', 'HTMLTextAreaElement', 'URLSearchParams', source)(
      fakeWindow,
      fakeDocument,
      HTMLTextAreaElement,
      URLSearchParams,
    );

    expect(registrations.map(([type, , capture]) => [type, capture])).toEqual([
      ['pointerdown', true],
      ['focus', true],
    ]);
    expect(registrations[0][1]).toBe(registrations[1][1]);
    expect(fakeDocument.addEventListener).not.toHaveBeenCalled();
    expect(fakeWindow.__rcImeProbe).toBeUndefined();

    const textarea = document.createElement('textarea');
    const value = vi.fn(() => 'draft');
    const selectionStart = vi.fn(() => 1);
    const selectionEnd = vi.fn(() => 3);
    Object.defineProperties(textarea, {
      value: { configurable: true, get: value },
      selectionStart: { configurable: true, get: selectionStart },
      selectionEnd: { configurable: true, get: selectionEnd },
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    registrations[0][1]({
      target: textarea,
      preventDefault,
      stopPropagation,
    } as unknown as Event);
    registrations[1][1]({
      target: textarea,
      preventDefault,
      stopPropagation,
    } as unknown as Event);

    expect(value).toHaveBeenCalledTimes(2);
    expect(selectionStart).toHaveBeenCalledTimes(2);
    expect(selectionEnd).toHaveBeenCalledTimes(2);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('ignores non-textarea targets without observing their value or selection', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'public/text-input-context-warmup.js'),
      'utf8',
    );
    const registrations: Array<[string, EventListener, boolean]> = [];
    const fakeWindow = {
      location: { search: '' },
      addEventListener: vi.fn((type: string, listener: EventListener, capture: boolean) => {
        registrations.push([type, listener, capture]);
      }),
    };
    const value = vi.fn(() => 'untouched');
    const target = {};
    Object.defineProperties(target, {
      value: { get: value },
      selectionStart: { get: vi.fn() },
      selectionEnd: { get: vi.fn() },
    });

    new Function('window', 'document', 'HTMLTextAreaElement', 'URLSearchParams', source)(
      fakeWindow,
      { addEventListener: vi.fn() },
      HTMLTextAreaElement,
      URLSearchParams,
    );
    registrations[0][1]({ target } as unknown as Event);

    expect(value).not.toHaveBeenCalled();
  });

  it('installs a content-free full IME matrix only in explicit probe mode', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'public/text-input-context-warmup.js'),
      'utf8',
    );
    const registrations: Array<[string, EventListener, boolean]> = [];
    const fakeDocument = {
      documentElement: { dataset: {} as Record<string, string> },
      addEventListener: vi.fn((type: string, listener: EventListener, capture: boolean) => {
        registrations.push([type, listener, capture]);
      }),
    };
    const fakeWindow: {
      location: { search: string };
      addEventListener: ReturnType<typeof vi.fn>;
      __rcImeProbe?: { mode: string; records: unknown[] };
    } = {
      location: { search: '?ime-probe=full' },
      addEventListener: vi.fn(),
    };

    new Function('window', 'document', 'HTMLTextAreaElement', 'URLSearchParams', source)(
      fakeWindow,
      fakeDocument,
      HTMLTextAreaElement,
      URLSearchParams,
    );

    expect(registrations.map(([type, , capture]) => [type, capture])).toEqual([
      ['keydown', true],
      ['keydown', false],
      ['compositionstart', true],
      ['compositionstart', false],
      ['compositionupdate', true],
      ['compositionupdate', false],
      ['beforeinput', true],
      ['beforeinput', false],
      ['input', true],
      ['input', false],
      ['compositionend', true],
      ['compositionend', false],
      ['keyup', true],
      ['keyup', false],
    ]);
    expect(fakeDocument.documentElement.dataset.rcImeProbe).toBe('full');
    expect(fakeWindow.__rcImeProbe).toEqual({ mode: 'full', records: [] });

    const textarea = document.createElement('textarea');
    textarea.value = 'secret';
    registrations[0][1]({
      target: textarea,
      type: 'keydown',
      keyCode: 229,
      isComposing: false,
    } as unknown as Event);

    expect(fakeWindow.__rcImeProbe?.records).toEqual([
      {
        type: 'keydown',
        phase: 'capture',
        keyCode: 229,
        isComposing: false,
        inputType: null,
        dataLength: null,
        valueLength: 6,
        selectionStart: 6,
        selectionEnd: 6,
      },
    ]);
    expect(JSON.stringify(fakeWindow.__rcImeProbe?.records)).not.toContain('secret');
    expect(fakeWindow.__rcImeProbe?.records[0]).not.toHaveProperty('key');
    expect(fakeWindow.__rcImeProbe?.records[0]).not.toHaveProperty('data');
    expect(fakeWindow.__rcImeProbe?.records[0]).not.toHaveProperty('value');

    for (let i = 0; i < 200; i += 1) {
      registrations[0][1]({
        target: textarea,
        type: 'keydown',
        keyCode: 229,
        isComposing: true,
      } as unknown as Event);
    }

    expect(fakeWindow.__rcImeProbe?.records).toHaveLength(200);
  });
});
