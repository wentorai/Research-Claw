import { describe, expect, it } from 'vitest';

import {
  PAPER_REVIEW_STAGES,
  buildStagedPaperReviewPrompt,
  mergeStagedReviewReport,
  stageOutputPath,
} from './paper-review-stages';

describe('paper-review-stages', () => {
  it('builds per-stage workspace paths', () => {
    expect(stageOutputPath('sources/paper.pdf', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'read-summary'))
      .toBe('outputs/reviews/paper-a1b2c3d4-read-summary.md');
  });

  it('stage 1 prompt scopes sections and stage output only', () => {
    const prompt = buildStagedPaperReviewPrompt({
      stage: PAPER_REVIEW_STAGES[0],
      stageIndex: 0,
      filePath: 'sources/paper.pdf',
      reviewId: 'rid-1',
      stageOutputPath: 'outputs/reviews/paper-rid1-read-summary.md',
      priorStagePaths: [],
      disciplineId: 'cs-ml',
      locale: 'zh-CN',
    });
    expect(prompt).toContain('当前步骤：1/3');
    expect(prompt).toContain('# Summary');
    expect(prompt).toContain('read-summary.md');
    expect(prompt).toContain('不要 rc.review.update 为 completed');
    expect(prompt).toContain('不要 send_notification');
  });

  it('final stage prompt reads prior stages only and writes verdict file', () => {
    const prompt = buildStagedPaperReviewPrompt({
      stage: PAPER_REVIEW_STAGES[2],
      stageIndex: 2,
      filePath: 'sources/paper.pdf',
      reviewId: 'rid-1',
      stageOutputPath: 'outputs/reviews/paper-rid1-verdict-merge.md',
      priorStagePaths: [
        'outputs/reviews/paper-rid1-read-summary.md',
        'outputs/reviews/paper-rid1-critique-experiments.md',
      ],
      disciplineId: 'cs-ml',
      locale: 'en',
    });
    expect(prompt).toContain('Current step: 3/3');
    expect(prompt).toContain('Do **NOT** re-read the PDF');
    expect(prompt).toContain('pdftotext');
    expect(prompt).toContain('read-summary.md');
    expect(prompt).toContain('verdict-merge.md');
    expect(prompt).toContain('do NOT rc.review.update');
    expect(prompt).toContain('do NOT send_notification');
  });

  it('merges staged markdown with review record header', () => {
    const merged = mergeStagedReviewReport('rid-1', ['# Summary\n\nA', '# Weaknesses\n\nB']);
    expect(merged).toContain('**Review Record ID:** `rid-1`');
    expect(merged).toContain('# Summary');
    expect(merged).toContain('# Weaknesses');
  });
});
