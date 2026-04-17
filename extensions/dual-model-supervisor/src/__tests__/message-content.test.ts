import { describe, expect, it } from 'vitest';
import { messageContentToPlainText, truncateMessagePlainText } from '../utils/message-content.js';

describe('messageContentToPlainText', () => {
  it('passes through strings', () => {
    expect(messageContentToPlainText('hello')).toBe('hello');
  });

  it('extracts Anthropic-style text blocks', () => {
    expect(
      messageContentToPlainText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]),
    ).toBe('a\nb');
  });

  it('avoids object Object for block arrays', () => {
    const s = messageContentToPlainText([{ type: 'text', text: 'x' }]);
    expect(s).not.toContain('[object Object]');
    expect(s).toBe('x');
  });

  it('truncates', () => {
    expect(truncateMessagePlainText('abcdef', 3)).toBe('abc');
  });
});
