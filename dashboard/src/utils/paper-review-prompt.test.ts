import { describe, expect, it } from 'vitest';

import {
  TOP_VENUE_PAPER_REVIEW_RUBRIC,
  buildTopVenuePaperReviewDisplayText,
  buildTopVenuePaperReviewPrompt,
} from './paper-review-prompt';
import { reviewOutputPath } from './paper-review-brief';

describe('paper-review-prompt', () => {
  it('includes the top-venue rubric sections', () => {
    expect(TOP_VENUE_PAPER_REVIEW_RUBRIC).toContain('NeurIPS / ICML / ICLR');
    expect(TOP_VENUE_PAPER_REVIEW_RUBRIC).toContain('# Top 5 Reject Reasons');
    expect(TOP_VENUE_PAPER_REVIEW_RUBRIC).toContain('# Accept / Borderline / Reject');
  });

  it('embeds the workspace paper path in the agent prompt', () => {
    const outputPath = reviewOutputPath('sources/paper.pdf', 'rev-1');
    const prompt = buildTopVenuePaperReviewPrompt('sources/paper.pdf', 'rev-1', outputPath);
    expect(prompt).toContain('`sources/paper.pdf`');
    expect(prompt).toContain('`rev-1`');
    expect(prompt).toContain('rc.review.update');
    expect(prompt).toContain('workspace_read');
    expect(prompt).toContain('禁止 pdf / exec / pdftotext');
    expect(prompt).toContain('send_notification');
    expect(prompt).toContain(outputPath);
    expect(prompt).toContain('不要在对话中输出任何内容');
  });

  it('uses discipline-specific rubric when provided', () => {
    const prompt = buildTopVenuePaperReviewPrompt(
      'sources/paper.pdf',
      'rev-1',
      reviewOutputPath('sources/paper.pdf', 'rev-1'),
      'cs-vision',
    );
    expect(prompt).toContain('CVPR / ICCV / ECCV');
    expect(prompt).toContain('`cs-vision`');
  });

  it('uses English report language when locale is en', () => {
    const prompt = buildTopVenuePaperReviewPrompt(
      'sources/paper.pdf',
      'rev-1',
      reviewOutputPath('sources/paper.pdf', 'rev-1'),
      'cs-ml',
      'en',
    );
    expect(prompt).toContain('Write the report body in English');
    expect(prompt).toContain('do NOT use pdf / exec / pdftotext');
    expect(prompt).not.toContain('报告正文请使用中文');
  });

  it('uses Chinese report language when locale is zh-CN', () => {
    const prompt = buildTopVenuePaperReviewPrompt(
      'sources/paper.pdf',
      'rev-1',
      reviewOutputPath('sources/paper.pdf', 'rev-1'),
      'cs-ml',
      'zh-CN',
    );
    expect(prompt).toContain('报告正文请使用中文');
    expect(prompt).toContain('禁止 pdf / exec / pdftotext');
    expect(prompt).toContain('[章节]');
    expect(prompt).toContain('Evidence Sufficiency');
  });

  it('uses a short display label for chat UI', () => {
    expect(buildTopVenuePaperReviewDisplayText('sources/paper.pdf')).toBe('【论文评审】paper.pdf');
  });
});
