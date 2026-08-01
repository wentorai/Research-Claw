import { describe, expect, it } from 'vitest';
import {
  collectPaperFenceAliases,
  parseRuntimeFileCard,
  parseRuntimePaperCard,
  suppressProjectedFileFences,
} from './card-runtime';

describe('paper/file runtime card validation and compatibility seam', () => {
  it('accepts the legacy file shape but rejects absolute and traversal paths', () => {
    expect(parseRuntimeFileCard('type: file_card\npath: outputs/report.md\nsize: 35KB')).toMatchObject({
      path: 'outputs/report.md', size_bytes: 35 * 1024,
    });
    expect(parseRuntimeFileCard('{"type":"file_card","path":"/etc/passwd","name":"x"}')).toBeNull();
    expect(parseRuntimeFileCard('{"type":"file_card","path":"../escape.md","name":"x"}')).toBeNull();
  });

  it('normalizes safe DOI/arXiv identities and rejects unsafe paper URLs', () => {
    expect(parseRuntimePaperCard(JSON.stringify({
      type: 'paper_card', title: 'Paper', authors: ['A'],
      doi: 'https://doi.org/10.1000/ABC', arxiv_id: '1706.03762v7',
    }))).toMatchObject({ doi: '10.1000/abc', arxiv_id: '1706.03762' });
    expect(parseRuntimePaperCard(JSON.stringify({
      type: 'paper_card', title: 'Paper', authors: ['A'], url: 'javascript:alert(1)',
    }))).not.toHaveProperty('url');
  });

  it('removes only the duplicate projected FileCard fence and preserves surrounding prose', () => {
    const message = {
      role: 'assistant',
      text: '已完成。\n\n```file_card\n{"type":"file_card","name":"r.md","path":"outputs/r.md"}\n```\n\n请继续检查。',
    };
    const result = suppressProjectedFileFences(message, new Set(['outputs/r.md']));
    expect(result.text).toBe('已完成。\n\n请继续检查。');

    const fourTicks = suppressProjectedFileFences({
      role: 'assistant',
      text: '仍保留说明。\n````file_card\npath: outputs/r.md\nsize: 1KB\n````',
    }, new Set(['outputs/r.md']));
    expect(fourTicks.text).toBe('仍保留说明。\n');
  });

  it('keeps a deliberate paper fence and exposes strong aliases for raw-candidate suppression', () => {
    const message = {
      role: 'assistant',
      text: '我主动选出这一篇：\n```paper_card\n{"type":"paper_card","title":"P","authors":[],"doi":"https://doi.org/10.1000/X","arxiv_id":"1706.03762v2"}\n```',
    };
    expect(collectPaperFenceAliases(message)).toEqual(new Set([
      'doi:10.1000/x', 'arxiv:1706.03762',
    ]));
    expect(suppressProjectedFileFences(message, new Set(['outputs/other.md']))).toEqual(message);
  });
});
