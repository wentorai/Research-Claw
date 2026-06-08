/**
 * Built-in top-venue paper review rubric for RC paper review.
 */

import {
  DEFAULT_REVIEW_DISCIPLINE,
  type ReviewDisciplineId,
  buildPaperReviewRubric,
  isZhReviewLocale,
} from './paper-review-discipline';

export type { ReviewDisciplineId } from './paper-review-discipline';
export {
  REVIEW_DISCIPLINES,
  DEFAULT_REVIEW_DISCIPLINE,
  buildPaperReviewRubric,
  getReviewDiscipline,
  isReviewDisciplineId,
} from './paper-review-discipline';

/** Default rubric (CS ML). Prefer buildPaperReviewRubric(disciplineId). */
export const TOP_VENUE_PAPER_REVIEW_RUBRIC = buildPaperReviewRubric(DEFAULT_REVIEW_DISCIPLINE);

export function buildTopVenuePaperReviewDisplayText(filePath: string): string {
  const name = filePath.trim().split('/').pop() ?? filePath.trim();
  return `【论文评审】${name}`;
}

function buildExecutionRequirements(
  path: string,
  reviewId: string,
  outputPath: string,
  disciplineId: ReviewDisciplineId,
  locale: string,
): string {
  if (isZhReviewLocale(locale)) {
    return `论文路径：\`${path}\`
评审记录 ID：\`${reviewId}\`
评审标准：\`${disciplineId}\`

执行要求（后台静默任务，无用户对话）：
1. 用 workspace_read 读取论文（path=\`${path}\`；**必须**使用 workspace_read；禁止 pdf / exec / pdftotext / document-extract）。
2. 严格按上述章节输出完整 Markdown 评审报告；报告开头须包含一行 **Review Record ID:** \`${reviewId}\`（勿写成 Paper ID）；Weaknesses / Top 5 Reject Reasons / Missing Experiments 每条须带 [章节] 与原文依据。
3. 将完整报告写入工作区文件 \`${outputPath}\`（workspace_save）。
4. 通过 rc.review.update 同步：report_markdown=完整报告，summary、strengths、weaknesses、suggestions、overall_score（1-10）、status=completed。
5. 完成后调用 send_notification（type=system）：title 含论文文件名，body 含 Final Score 与 Accept/Borderline/Reject 结论。
6. 不要在对话中输出任何内容（包括确认语）；仅写入文件、更新评审记录并发送通知。`;
  }

  return `Paper path: \`${path}\`
Review record ID: \`${reviewId}\`
Review rubric: \`${disciplineId}\`

Execution requirements (silent background task, no user conversation):
1. Read the paper with workspace_read (path=\`${path}\`; **must** use workspace_read — do NOT use pdf / exec / pdftotext / document-extract).
2. Output a complete Markdown review following the sections above; start the report with **Review Record ID:** \`${reviewId}\` (not Paper ID); every Weaknesses / Top 5 Reject Reasons / Missing Experiments bullet must cite [section] and evidence.
3. Write the full report to workspace file \`${outputPath}\` (workspace_save).
4. Sync via rc.review.update: report_markdown=full report, summary, strengths, weaknesses, suggestions, overall_score (1-10), status=completed.
5. After completion call send_notification (type=system): title includes the paper filename, body includes Final Score and Accept/Borderline/Reject verdict.
6. Do not output anything in the conversation (including acknowledgements); only write the file, update the review record, and send notification.`;
}

export function buildTopVenuePaperReviewPrompt(
  filePath: string,
  reviewId: string,
  outputPath: string,
  disciplineId: ReviewDisciplineId = DEFAULT_REVIEW_DISCIPLINE,
  locale: string = 'zh-CN',
): string {
  const path = filePath.trim();
  const rubric = buildPaperReviewRubric(disciplineId, locale);
  return `${rubric}

---

${buildExecutionRequirements(path, reviewId, outputPath, disciplineId, locale)}`;
}
