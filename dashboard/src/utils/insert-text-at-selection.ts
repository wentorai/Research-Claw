export interface TextSelection {
  start: number;
  end: number;
}

export interface InsertTextResult {
  value: string;
  caret: number;
  usedNativeUndoTransaction: boolean;
}

/**
 * Insert text as a browser editing operation. Chromium's insertText command adds
 * one native undo transaction; setRangeText is the behavior-preserving fallback.
 */
export function insertTextAtSelection(
  textarea: HTMLTextAreaElement,
  text: string,
  selection: TextSelection = {
    start: textarea.selectionStart ?? textarea.value.length,
    end: textarea.selectionEnd ?? textarea.value.length,
  },
): InsertTextResult {
  const start = Math.max(0, Math.min(selection.start, textarea.value.length));
  const end = Math.max(start, Math.min(selection.end, textarea.value.length));
  textarea.focus();
  textarea.setSelectionRange(start, end);

  const canUseNative = typeof document.execCommand === 'function';
  const usedNativeUndoTransaction = canUseNative
    ? document.execCommand('insertText', false, text)
    : false;

  if (!usedNativeUndoTransaction) {
    textarea.setRangeText(text, start, end, 'end');
    const fallbackCaret = start + text.length;
    textarea.setSelectionRange(fallbackCaret, fallbackCaret);
    const inputEvent = typeof InputEvent === 'function'
      ? new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
      : new Event('input', { bubbles: true });
    textarea.dispatchEvent(inputEvent);
  }

  const caret = textarea.selectionEnd ?? start + text.length;
  return { value: textarea.value, caret, usedNativeUndoTransaction };
}
