import { describe, expect, it } from 'vitest';

import {
  CHAT_DROP_DIR,
  MAX_REFERENCE_SIZE,
  REFERENCE_BLOCK_HEADER,
  appendReferenceBlock,
  basenameOf,
  buildReferenceBlock,
  composerDropDestination,
  dedupePaths,
  isImagePath,
  safeUploadName,
  timestampedUploadName,
} from './file-reference';

describe('file-reference helpers', () => {
  it('soft cap is 100MB', () => {
    expect(MAX_REFERENCE_SIZE).toBe(100 * 1024 * 1024);
  });

  describe('isImagePath', () => {
    it('matches common image extensions (case-insensitive)', () => {
      for (const p of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.GIF', 'sources/f.heic', 'x.svg', 'y.avif']) {
        expect(isImagePath(p)).toBe(true);
      }
    });
    it('rejects non-image extensions', () => {
      for (const p of ['a.pdf', 'b.csv', 'c.txt', 'data', 'mac.dmg', 'notes.md']) {
        expect(isImagePath(p)).toBe(false);
      }
    });
  });

  describe('basenameOf', () => {
    it('returns last segment for / and \\ separators', () => {
      expect(basenameOf('uploads/data.csv')).toBe('data.csv');
      expect(basenameOf('a/b/c/paper.pdf')).toBe('paper.pdf');
      expect(basenameOf('C\\\\Users\\\\x\\\\mac.dmg')).toBe('mac.dmg');
      expect(basenameOf('plain.txt')).toBe('plain.txt');
    });
    it('handles trailing slash (directory)', () => {
      expect(basenameOf('sources/figures/')).toBe('figures');
    });
  });

  describe('safeUploadName', () => {
    it('sanitizes unsafe characters', () => {
      expect(safeUploadName('my file (1).pdf')).toBe('my_file__1_.pdf');
      // Leading underscores (from stripped CJK) are trimmed.
      expect(safeUploadName('数据.csv')).toBe('.csv');
    });
    it('never returns empty', () => {
      expect(safeUploadName('***')).toBe('file');
    });
  });

  describe('timestampedUploadName', () => {
    it('prefixes a deterministic timestamp', () => {
      expect(timestampedUploadName('paper.pdf', 1717000000000)).toBe('1717000000000-paper.pdf');
    });
  });

  describe('composerDropDestination', () => {
    it('routes non-image drops into the chat inbox (never uploads/)', () => {
      expect(CHAT_DROP_DIR).toBe('sources/chat');
      for (const name of ['data.csv', 'paper.pdf', 'mac.dmg', 'notes.md']) {
        expect(composerDropDestination(name, false)).toBe('sources/chat');
      }
    });
    it('routes images (by extension or MIME) to sources/', () => {
      expect(composerDropDestination('fig.png', false)).toBe('sources');
      // MIME says image even though the name has no image extension.
      expect(composerDropDestination('camera-roll', true)).toBe('sources');
    });
    it('provisional chip path for a non-image drop starts with sources/chat/', () => {
      const dest = composerDropDestination('data.csv', false);
      const chipPath = `${dest}/${timestampedUploadName('data.csv', 1717000000000)}`;
      expect(chipPath).toBe('sources/chat/1717000000000-data.csv');
    });
  });

  describe('dedupePaths', () => {
    it('removes duplicates, preserving first-seen order', () => {
      expect(dedupePaths(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
    });
  });

  describe('buildReferenceBlock', () => {
    it('returns empty string for no paths', () => {
      expect(buildReferenceBlock([])).toBe('');
      expect(buildReferenceBlock(['', '  '])).toBe('');
    });
    it('renders a header + @-prefixed bullet list, deduped', () => {
      const block = buildReferenceBlock(['uploads/mac.dmg', 'sources/paper.pdf', 'uploads/mac.dmg']);
      expect(block).toBe(`${REFERENCE_BLOCK_HEADER}\n- @uploads/mac.dmg\n- @sources/paper.pdf`);
    });
  });

  describe('appendReferenceBlock', () => {
    it('appends with a blank-line separator', () => {
      const out = appendReferenceBlock('summarize these', ['uploads/a.pdf']);
      expect(out).toBe(`summarize these\n\n${REFERENCE_BLOCK_HEADER}\n- @uploads/a.pdf`);
    });
    it('returns just the block when message is empty', () => {
      expect(appendReferenceBlock('', ['uploads/a.pdf'])).toBe(buildReferenceBlock(['uploads/a.pdf']));
    });
    it('returns the message unchanged when no paths', () => {
      expect(appendReferenceBlock('hello', [])).toBe('hello');
    });
  });
});
