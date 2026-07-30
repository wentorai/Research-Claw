import { describe, expect, it, vi } from 'vitest';
import { insertTextAtSelection } from './insert-text-at-selection';

describe('insertTextAtSelection', () => {
  it('uses the browser insertText editing transaction when available', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'alpha omega';
    document.body.appendChild(textarea);
    const exec = vi.fn((_command: string, _ui: boolean, value?: string) => {
      textarea.setRangeText(String(value), textarea.selectionStart, textarea.selectionEnd, 'end');
      const caret = 6 + String(value).length;
      textarea.setSelectionRange(caret, caret);
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return true;
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });

    const result = insertTextAtSelection(textarea, 'beta ', { start: 6, end: 6 });
    expect(exec).toHaveBeenCalledWith('insertText', false, 'beta ');
    expect(result).toEqual({
      value: 'alpha beta omega',
      caret: 11,
      usedNativeUndoTransaction: true,
    });
    delete (document as unknown as Record<string, unknown>).execCommand;
    textarea.remove();
  });

  it('replaces a selection and dispatches an input event on the fallback path', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'alpha old omega';
    document.body.appendChild(textarea);
    const original = document.execCommand;
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined });
    const onInput = vi.fn();
    textarea.addEventListener('input', onInput);

    const result = insertTextAtSelection(textarea, 'new', { start: 6, end: 9 });
    expect(result.value).toBe('alpha new omega');
    expect(result.caret).toBe(9);
    expect(result.usedNativeUndoTransaction).toBe(false);
    expect(onInput).toHaveBeenCalledOnce();

    Object.defineProperty(document, 'execCommand', { configurable: true, value: original });
    textarea.remove();
  });
});
