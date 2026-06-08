import { describe, expect, it } from 'vitest';

import { buildIntraViewPrompt, buildIntraViewSendPayload, resolvePaperReadPath } from './intraview-prompt';
import { sanitizeUserMessage } from './sanitize-message';
import type { Paper } from '../stores/library';

const basePaper: Paper = {
  id: 'paper-1',
  title: 'Attention Is All You Need',
  authors: ['Vaswani, A.'],
  abstract: 'We propose the Transformer architecture.',
  doi: '10.1234/example',
  url: null,
  arxiv_id: '1706.03762',
  pdf_path: 'sources/transformer.pdf',
  source: null,
  source_id: null,
  venue: 'NeurIPS',
  year: 2017,
  read_status: 'unread',
  rating: null,
  notes: null,
  bibtex_key: null,
  metadata: {},
  added_at: '',
  updated_at: '',
};

describe('intraview-prompt', () => {
  it('resolves workspace pdf path', () => {
    expect(resolvePaperReadPath(basePaper)).toBe('sources/transformer.pdf');
    expect(resolvePaperReadPath({ ...basePaper, pdf_path: '  ' })).toBeNull();
  });

  it('builds Chinese IntraView prompt with section-ranking workflow', () => {
    const prompt = buildIntraViewPrompt(basePaper, 'baseline 是什么？', 'zh-CN');
    expect(prompt).toContain('【IntraView 文献精读】');
    expect(prompt).toContain('sources/transformer.pdf');
    expect(prompt).toContain('workspace_read');
    expect(prompt).toContain('baseline 是什么？');
    expect(prompt).toContain('章节排序');
    expect(prompt).toContain('Confidence');
  });

  it('builds English IntraView prompt when locale is en', () => {
    const prompt = buildIntraViewPrompt(basePaper, 'What is the baseline?', 'en');
    expect(prompt).toContain('[IntraView]');
    expect(prompt).toContain('Section ranking');
    expect(prompt).not.toContain('章节排序');
  });

  it('notes missing pdf path in prompt', () => {
    const prompt = buildIntraViewPrompt(
      { ...basePaper, pdf_path: null },
      'What dataset?',
      'en',
    );
    expect(prompt).toContain('no local PDF linked');
    expect(prompt).toContain('arXiv: 1706.03762');
  });

  it('hides IntraView instructions from chat display after sanitize', () => {
    const question = 'Table 2 用了哪些 baseline？';
    const { agentMessage, displayText } = buildIntraViewSendPayload(basePaper, question, 'zh-CN');
    expect(displayText).toBe(question);
    expect(agentMessage).toContain('[Research-Claw] IntraView');
    expect(agentMessage).toContain('【IntraView 文献精读】');
    expect(sanitizeUserMessage(agentMessage)).toBe(question);
  });
});
