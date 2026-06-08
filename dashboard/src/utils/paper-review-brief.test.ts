import { describe, expect, it } from 'vitest';

import { buildPaperReviewBrief, buildReviewRecordSummary, extractReviewIdFromReport, getReviewSequenceNumber, parseEvidenceSufficiencyStatus, reportBelongsToReview, reviewOutputPath } from './paper-review-brief';

describe('paper-review-brief', () => {
  it('parses score and verdict from report markdown', () => {
    const brief = buildPaperReviewBrief({
      id: '1',
      file_path: 'sources/paper.pdf',
      paper_id: null,
      title: 'paper',
      status: 'completed',
      overall_score: null,
      summary: null,
      strengths: null,
      weaknesses: null,
      suggestions: null,
      report_markdown: `# Summary
A concise summary.

# Final Score (1-10)
7 / 10

# Confidence (1-5)
4

# Accept / Borderline / Reject
Borderline

# Top 5 Reject Reasons
- [Experiments §4.2] Missing ablations on large models — evidence: "only ResNet-50"

# Evidence Sufficiency
partial

Coverage: Introduction, Experiments
`,
      rubric: null,
      failure_reason: null,
      created_at: '',
      updated_at: '',
    });

    expect(brief.summary).toBe('A concise summary.');
    expect(brief.score).toBe(7);
    expect(brief.confidence).toBe('4');
    expect(brief.verdict).toBe('Borderline');
    expect(brief.topRejectReason).toContain('[Experiments §4.2]');
    expect(brief.evidenceSufficiency).toBe('partial');
    expect(brief.evidenceSufficiencyDetail).toContain('Coverage: Introduction, Experiments');
  });

  it('parses evidence sufficiency status', () => {
    expect(parseEvidenceSufficiencyStatus('sufficient\nCoverage: all')).toBe('sufficient');
    expect(parseEvidenceSufficiencyStatus('not_found')).toBe('not_found');
    expect(parseEvidenceSufficiencyStatus('partial')).toBe('partial');
  });

  it('builds per-review output path under outputs/reviews/', () => {
    expect(reviewOutputPath('sources/大模型幻觉抑制.pdf', 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'))
      .toBe('outputs/reviews/大模型幻觉抑制-a1b2c3d4-review.md');
    expect(reviewOutputPath('sources/paper.pdf')).toBe('outputs/reviews/paper-review.md');
  });

  it('assigns chronological sequence numbers (1 = oldest)', () => {
    expect(getReviewSequenceNumber(0, 3)).toBe(3);
    expect(getReviewSequenceNumber(2, 3)).toBe(1);
  });

  it('builds select summary from review report', () => {
    const summary = buildReviewRecordSummary({
      id: '1',
      file_path: 'sources/a.pdf',
      paper_id: null,
      title: 'a',
      status: 'completed',
      overall_score: 4,
      summary: null,
      strengths: null,
      weaknesses: null,
      suggestions: null,
      report_markdown: '# Accept / Borderline / Reject\n**Reject**',
      rubric: null,
      failure_reason: null,
      created_at: '',
      updated_at: '',
    });
    expect(summary.score).toBe('4/10');
    expect(summary.verdict).toBe('Reject');
  });

  it('detects embedded review id in report markdown', () => {
    const id = 'c4f6c2d3-6b93-41e9-ab9a-67d8c6a35e55';
    const md = `# Summary\n\n**Review Record ID:** ${id}\n`;
    expect(extractReviewIdFromReport(md)).toBe(id);
    expect(reportBelongsToReview(md, id)).toBe(true);
    expect(reportBelongsToReview(md, 'other-id')).toBe(false);
  });

  it('rejects legacy fallback reports whose embedded id belongs to another review', () => {
    const other = 'c01dd524-7ec1-4691-8fcd-dadafeeac750';
    const md = `# Summary\n\n**Paper ID:** ${other}\n`;
    expect(extractReviewIdFromReport(md)).toBe(other);
    expect(reportBelongsToReview(md, 'af31c5b6-0292-48a5-a779-0ca6b040976f', { legacyFallback: true })).toBe(false);
  });

  it('rejects legacy fallback when report has no embedded review id', () => {
    const md = '# Summary\nEnglish report without id header.\n';
    expect(reportBelongsToReview(md, 'af31c5b6-0292-48a5-a779-0ca6b040976f', { legacyFallback: true })).toBe(false);
    expect(reportBelongsToReview(md, 'af31c5b6-0292-48a5-a779-0ca6b040976f')).toBe(true);
  });
});
