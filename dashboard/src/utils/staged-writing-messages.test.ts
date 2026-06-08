import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';

import { buildInitialStageStates } from './staged-writing-stages';
import { STAGED_WRITING_STAGES } from './staged-writing-stages';
import { formatStagedWritingAssistantText } from './staged-writing-messages';
import type { StagedWritingJob } from './staged-writing-run';

const t = ((key: string, opts?: Record<string, unknown>) => {
  if (key === 'stagedWriting.assistant.stepDone') {
    return `step:${opts?.path}:${opts?.done}/${opts?.total}`;
  }
  if (key === 'stagedWriting.assistant.header') {
    return `header:${opts?.done}/${opts?.total}:${opts?.status}`;
  }
  if (key.startsWith('stagedWriting.stages.')) return key.replace('stagedWriting.stages.', '');
  if (key.startsWith('stagedWriting.status.')) return key.replace('stagedWriting.status.', '');
  if (key === 'stagedWriting.assistant.runningHint') return 'running-hint';
  if (key === 'stagedWriting.assistant.completedHint') return 'completed-hint';
  if (key === 'stagedWriting.assistant.resumeHint') return 'resume-hint';
  if (key === 'stagedWriting.assistant.filesHeading') return 'files-heading';
  return key;
}) as TFunction;

function makeJob(partial?: Partial<StagedWritingJob>): StagedWritingJob {
  return {
    id: 'job-1',
    slug: '',
    topic: 'TNBC paper',
    sourcePaths: ['sources/'],
    venue: '',
    locale: 'zh-CN',
    outputDir: 'outputs/drafts',
    startedAtMs: Date.now(),
    status: 'running',
    currentStageIndex: 1,
    stages: buildInitialStageStates('outputs/drafts'),
    lastError: null,
    ...partial,
  };
}

describe('formatStagedWritingAssistantText', () => {
  it('step_done is a short line without full checklist', () => {
    const job = makeJob({
      stages: buildInitialStageStates('outputs/drafts').map((s, i) =>
        i === 0 ? { ...s, status: 'done', completedAtMs: 1 } : s,
      ),
    });
    const text = formatStagedWritingAssistantText(job, 'step_done', t);
    expect(text).toBe('step:outputs/drafts/01_introduction.md:1/6');
    expect(text).not.toContain('header:');
  });

  it('started includes checklist and running hint', () => {
    const text = formatStagedWritingAssistantText(makeJob(), 'started', t);
    expect(text).toContain('header:0/6:running');
    expect(text).toContain('introduction');
    expect(text).toContain('running-hint');
  });

  it('completed adds file cards for done stages', () => {
    const stages = buildInitialStageStates('outputs/drafts').map((s) => ({
      ...s,
      status: 'done' as const,
      completedAtMs: 1,
    }));
    const text = formatStagedWritingAssistantText(
      makeJob({ status: 'completed', stages }),
      'completed',
      t,
    );
    expect(text).toContain('completed-hint');
    expect(text).toContain('```file_card');
    expect(text).toContain(STAGED_WRITING_STAGES[0].fileName);
  });
});
