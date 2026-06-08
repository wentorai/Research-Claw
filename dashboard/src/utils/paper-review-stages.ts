/**
 * Staged paper review — split one long run into shorter cron steps to avoid LLM idle timeout.
 */

import {
  type ReviewDisciplineId,
  buildPaperReviewRubric,
  isZhReviewLocale,
} from './paper-review-discipline';
import { reviewOutputPath } from './paper-review-brief';

export interface PaperReviewStageDef {
  id: 'read-summary' | 'critique-experiments' | 'verdict-merge';
  /** i18n key under paperReview.stages */
  titleKey: string;
  /** Markdown H1 sections this stage must produce */
  sections: readonly string[];
}

export const PAPER_REVIEW_STAGES: readonly PaperReviewStageDef[] = [
  {
    id: 'read-summary',
    titleKey: 'readSummary',
    sections: ['Summary', 'Main Contributions', 'Strengths', 'Novelty Analysis'],
  },
  {
    id: 'critique-experiments',
    titleKey: 'critiqueExperiments',
    sections: [
      'Weaknesses',
      'Experimental Analysis',
      'Statistical Analysis',
      'Missing Experiments',
      'Reproducibility',
    ],
  },
  {
    id: 'verdict-merge',
    titleKey: 'verdictMerge',
    sections: [
      'Top 5 Reject Reasons',
      'Questions For Authors',
      'Evidence Sufficiency',
      'Final Score (1-10)',
      'Confidence (1-5)',
      'Accept / Borderline / Reject',
    ],
  },
] as const;

const MIN_STAGE_FILE_CHARS = 80;

export function stageOutputPath(filePath: string, reviewId: string, stageId: string): string {
  const base = reviewOutputPath(filePath, reviewId).replace(/-review\.md$/, '');
  return `${base}-${stageId}.md`;
}

export function minStageFileChars(): number {
  return MIN_STAGE_FILE_CHARS;
}

function formatSectionList(sections: readonly string[]): string {
  return sections.map((s) => `# ${s}`).join('\n\n');
}

function buildStageExecutionBlock(params: {
  locale: string;
  path: string;
  reviewId: string;
  disciplineId: ReviewDisciplineId;
  stageOutputPath: string;
  priorStagePaths: string[];
  stageIndex: number;
  stageTotal: number;
  sections: readonly string[];
  isFinalStage: boolean;
}): string {
  const priorList = params.priorStagePaths.length
    ? params.priorStagePaths.map((p) => `- \`${p}\``).join('\n')
    : null;

  if (isZhReviewLocale(params.locale)) {
    const lines = [
      `论文路径：\`${params.path}\``,
      `评审记录 ID：\`${params.reviewId}\``,
      `评审标准：\`${params.disciplineId}\``,
      `当前步骤：${params.stageIndex + 1}/${params.stageTotal}`,
      '',
      '执行要求（后台静默任务，无用户对话）：',
    ];
    if (params.isFinalStage) {
      lines.push(
        '1. **不要**再次读取 PDF；不要 workspace_read 论文路径；禁止 pdf / exec / pdftotext / document-extract。',
        `2. 读取前序步骤产物（rc.ws.read）：\n${priorList ?? '（无）'}`,
        `3. 仅输出以下章节（不要输出其它章节）：\n${formatSectionList(params.sections)}`,
        '4. Top 5 Reject Reasons / Questions For Authors 中每条须带 [章节/§X.Y] 与原文依据。',
        `5. 将本步骤 Markdown 写入 \`${params.stageOutputPath}\`（workspace_save）。`,
        '6. 不要写入最终 `-review.md`；不要 rc.review.update；不要 send_notification（Dashboard 会合并并同步）。',
        '7. 不要在对话中输出任何内容（包括确认语）。',
      );
    } else {
      lines.push(
        `1. 读取论文：workspace_read path=\`${params.path}\`（必须用 workspace_read；禁止 pdf / document-extract 工具）。`,
      );
      if (priorList) {
        lines.push(`2. 读取前序步骤产物（rc.ws.read）：\n${priorList}`);
        lines.push(`3. 仅输出以下章节（不要输出其它章节）：\n${formatSectionList(params.sections)}`);
        lines.push(
          '4. Weaknesses / Missing Experiments 中每条须带 [章节/§X.Y] 与原文依据。',
        );
      } else {
        lines.push(`2. 仅输出以下章节（不要输出其它章节）：\n${formatSectionList(params.sections)}`);
      }
      lines.push(
        `5. 将本步骤 Markdown 写入 \`${params.stageOutputPath}\`（workspace_save）。`,
        '6. 不要写入最终评审文件，不要 rc.review.update 为 completed，不要 send_notification。',
        '7. 不要在对话中输出任何内容（包括确认语）。',
      );
    }
    return lines.join('\n');
  }

  const lines = [
    `Paper path: \`${params.path}\``,
    `Review record ID: \`${params.reviewId}\``,
    `Review rubric: \`${params.disciplineId}\``,
    `Current step: ${params.stageIndex + 1}/${params.stageTotal}`,
    '',
    'Execution requirements (silent background task, no user conversation):',
  ];
  if (params.isFinalStage) {
    lines.push(
      '1. Do **NOT** re-read the PDF; do not workspace_read the paper path; do NOT use pdf / exec / pdftotext / document-extract.',
      `2. Read prior step outputs (rc.ws.read):\n${priorList ?? '(none)'}`,
      `3. Output ONLY these sections (no other sections):\n${formatSectionList(params.sections)}`,
      '4. Every Top 5 Reject Reasons / Questions For Authors bullet must cite [section] and evidence.',
      `5. Write this step Markdown to \`${params.stageOutputPath}\` (workspace_save).`,
      '6. Do NOT write the final `-review.md`; do NOT rc.review.update; do NOT send_notification (Dashboard merges and syncs).',
      '7. Do not output anything in the conversation.',
    );
  } else {
    lines.push(
      `1. Read the paper with workspace_read (path=\`${params.path}\`; must use workspace_read — do NOT use pdf or document-extract tools).`,
    );
    if (priorList) {
      lines.push(`2. Read prior step outputs (rc.ws.read):\n${priorList}`);
      lines.push(`3. Output ONLY these sections (no other sections):\n${formatSectionList(params.sections)}`);
      lines.push(
        '4. Every Weaknesses / Missing Experiments bullet must cite [section] and evidence.',
      );
    } else {
      lines.push(`2. Output ONLY these sections:\n${formatSectionList(params.sections)}`);
    }
    lines.push(
      `5. Write this step Markdown to \`${params.stageOutputPath}\` (workspace_save).`,
      '6. Do NOT write the final review file, do NOT mark rc.review.update completed, do NOT send_notification.',
      '7. Do not output anything in the conversation.',
    );
  }
  return lines.join('\n');
}

/** Concatenate staged review files into the final report (Dashboard-side merge). */
export function mergeStagedReviewReport(reviewId: string, stageMarkdowns: readonly string[]): string {
  const header = `**Review Record ID:** \`${reviewId}\`\n\n`;
  const body = stageMarkdowns.map((chunk) => chunk.trim()).filter(Boolean).join('\n\n');
  return header + body;
}

export function buildStagedPaperReviewPrompt(params: {
  stage: PaperReviewStageDef;
  stageIndex: number;
  filePath: string;
  reviewId: string;
  stageOutputPath: string;
  priorStagePaths: string[];
  disciplineId: ReviewDisciplineId;
  locale?: string;
}): string {
  const locale = params.locale ?? 'zh-CN';
  const rubric = buildPaperReviewRubric(params.disciplineId, locale);
  const isFinalStage = params.stageIndex === PAPER_REVIEW_STAGES.length - 1;
  const execution = buildStageExecutionBlock({
    locale,
    path: params.filePath.trim(),
    reviewId: params.reviewId,
    disciplineId: params.disciplineId,
    stageOutputPath: params.stageOutputPath,
    priorStagePaths: params.priorStagePaths,
    stageIndex: params.stageIndex,
    stageTotal: PAPER_REVIEW_STAGES.length,
    sections: params.stage.sections,
    isFinalStage,
  });

  return `${rubric}

---

${execution}`;
}
