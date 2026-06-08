import type { TFunction } from 'i18next';

import { STAGED_WRITING_STAGES } from './staged-writing-stages';
import {
  countCompletedStages,
  type StagedWritingJob,
  type StagedWritingStageStatus,
} from './staged-writing-run';

export type StagedWritingMessageKind =
  | 'started'
  | 'resumed'
  | 'step_done'
  | 'completed'
  | 'partial'
  | 'failed';

function stageMark(status: StagedWritingStageStatus): string {
  switch (status) {
    case 'done':
      return '✅';
    case 'running':
      return '⏳';
    case 'failed':
      return '❌';
    default:
      return '○';
  }
}

function fileCardBlock(path: string): string {
  const name = path.split('/').pop() ?? path;
  return ['```file_card', JSON.stringify({ type: 'file_card', name, path }), '```'].join('\n');
}

/** Full progress report as assistant markdown (scrolls with chat history). */
export function formatStagedWritingAssistantText(
  job: StagedWritingJob,
  kind: StagedWritingMessageKind,
  t: TFunction,
): string {
  const done = countCompletedStages(job.stages);
  const total = STAGED_WRITING_STAGES.length;
  const lines: string[] = [];

  if (kind === 'step_done') {
    const running = job.stages.find((s) => s.status === 'running');
    const justDone = [...job.stages].reverse().find((s) => s.status === 'done');
    const path = justDone?.outputPath ?? running?.outputPath ?? '';
    lines.push(t('stagedWriting.assistant.stepDone', { path, done, total }));
    return lines.join('\n');
  }

  lines.push(t('stagedWriting.assistant.header', {
    done,
    total,
    status: t(`stagedWriting.status.${job.status}`),
  }));
  lines.push('');

  job.stages.forEach((stage, index) => {
    const def = STAGED_WRITING_STAGES[index];
    const label = t(`stagedWriting.stages.${def.titleKey}`);
    lines.push(`${stageMark(stage.status)} **${label}** — \`${stage.outputPath}\``);
  });

  if (job.lastError) {
    lines.push('');
    lines.push(`> ${job.lastError}`);
  }

  lines.push('');
  if (kind === 'completed') {
    lines.push(t('stagedWriting.assistant.completedHint'));
  } else if (kind === 'partial' || kind === 'failed') {
    lines.push(t('stagedWriting.assistant.resumeHint'));
  } else {
    lines.push(t('stagedWriting.assistant.runningHint'));
  }

  if (kind === 'completed' || kind === 'partial') {
    const doneStages = job.stages.filter((s) => s.status === 'done');
    if (doneStages.length > 0) {
      lines.push('');
      lines.push(t('stagedWriting.assistant.filesHeading'));
      for (const stage of doneStages) {
        lines.push(fileCardBlock(stage.outputPath));
      }
    }
  }

  return lines.join('\n');
}
