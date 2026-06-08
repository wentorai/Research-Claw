import { describe, expect, it } from 'vitest';

import {
  buildPaperReviewRubric,
  getReviewDiscipline,
  isReviewDisciplineId,
} from './paper-review-discipline';

describe('paper-review-discipline', () => {
  it('builds rubrics with discipline-specific venues', () => {
    expect(buildPaperReviewRubric('cs-ml')).toContain('NeurIPS / ICML / ICLR');
    expect(buildPaperReviewRubric('cs-vision')).toContain('CVPR / ICCV / ECCV');
    expect(buildPaperReviewRubric('economics')).toContain('AER / QJE / Econometrica');
  });

  it('general rubric asks agent to infer field', () => {
    expect(buildPaperReviewRubric('general')).toContain('判断其所属学科领域');
  });

  it('uses English requirements when locale is en', () => {
    expect(buildPaperReviewRubric('cs-ml', 'en')).toContain('Write the report body in English');
    expect(buildPaperReviewRubric('cs-ml', 'en')).toContain('[Section/§X.Y]');
    expect(buildPaperReviewRubric('cs-ml', 'en')).toContain('Evidence Sufficiency');
  });

  it('requires section citations in Chinese rubric', () => {
    expect(buildPaperReviewRubric('cs-ml', 'zh-CN')).toContain('[章节名/§X.Y]');
    expect(buildPaperReviewRubric('cs-ml', 'zh-CN')).toContain('Evidence Sufficiency');
  });

  it('validates discipline ids', () => {
    expect(isReviewDisciplineId('cs-nlp')).toBe(true);
    expect(isReviewDisciplineId('invalid')).toBe(false);
    expect(getReviewDiscipline('cs-security').venues).toContain('CCS');
  });
});
