import { describe, it, expect } from 'vitest';
import {
  STAGED_WRITING_STAGES,
  buildInitialStageStates,
  buildStagedWritingPrompt,
  stageOutputPath,
} from './staged-writing-stages';
import {
  countCompletedStages,
  isStagedWritingJobForSession,
  resolveStagedWritingJobSessionKey,
  slugifyWritingTopic,
  stagePollDeadlineMs,
  uniqueWritingSlug,
  writingOutputDir,
} from './staged-writing-run';

describe('staged-writing-stages', () => {
  it('builds six IMRaD stages with stable file names', () => {
    expect(STAGED_WRITING_STAGES).toHaveLength(6);
    expect(STAGED_WRITING_STAGES[0].fileName).toBe('01_introduction.md');
    expect(STAGED_WRITING_STAGES[4].fileName).toBe('05_abstract.md');
  });

  it('stageOutputPath joins output dir and file name', () => {
    expect(stageOutputPath('outputs/drafts/tnbc', '01_introduction.md'))
      .toBe('outputs/drafts/tnbc/01_introduction.md');
  });

  it('prompt enforces single-section save path', () => {
    const prompt = buildStagedWritingPrompt({
      jobId: 'job-1',
      locale: 'zh-CN',
      topic: 'TNBC MRI',
      contextText: '用户：分析 TNBC MRI 数据',
      venue: 'Academic Radiology',
      sourcePaths: ['sources/data.csv'],
      stage: STAGED_WRITING_STAGES[0],
      stageIndex: 0,
      stageTotal: 6,
      outputPath: 'outputs/drafts/01_introduction.md',
      priorOutputPaths: [],
    });
    expect(prompt).toContain('[rc-writing]');
    expect(prompt).toContain('outputs/drafts/01_introduction.md');
    expect(prompt).toContain('只写本节');
    expect(prompt).toContain('禁止一次生成全文');
    expect(prompt).toContain('分析 TNBC MRI 数据');
    expect(prompt).toContain('禁止读取其它 workspace 文件');
    expect(prompt).toContain('明确列出的 DOCX');
  });

  it('buildInitialStageStates uses output dir', () => {
    const states = buildInitialStageStates('outputs/drafts');
    expect(states[0].outputPath).toBe('outputs/drafts/01_introduction.md');
    expect(states.every((s) => s.status === 'pending')).toBe(true);
  });
});

describe('staged-writing-run', () => {
  it('slugifyWritingTopic normalizes topic', () => {
    expect(slugifyWritingTopic('  TNBC MRI Paper!!! ')).toBe('tnbc-mri-paper');
  });

  it('writingOutputDir uses slug subfolder or flat drafts', () => {
    expect(writingOutputDir('tnbc')).toBe('outputs/drafts/tnbc');
    expect(writingOutputDir('')).toBe('outputs/drafts');
  });

  it('uniqueWritingSlug isolates repeated chat-triggered runs', () => {
    expect(uniqueWritingSlug('TNBC MRI Paper', '12345678-abcd')).toBe('paper-12345678');
    expect(uniqueWritingSlug('TNBC MRI Paper', '87654321-abcd')).not.toBe(
      uniqueWritingSlug('TNBC MRI Paper', '12345678-abcd'),
    );
  });

  it('uniqueWritingSlug does not copy the full user prompt into the output directory', () => {
    const slug = uniqueWritingSlug(
      '根据 TAIS 框架项目，生成一篇完整的小论文',
      '9b60e6ae-abcd',
    );
    expect(slug).toBe('paper-9b60e6ae');
    expect(slug).not.toContain('根据');
  });

  it('stagePollDeadlineMs includes grace after timeout', () => {
    const start = 1_000_000;
    expect(stagePollDeadlineMs(start)).toBe(start + 300_000 + 45_000);
  });

  it('stagePollDeadlineMs supports a longer merge timeout', () => {
    const start = 1_000_000;
    expect(stagePollDeadlineMs(start, 600)).toBe(start + 600_000 + 45_000);
  });

  it('merge prompt only permits prior stage files', () => {
    const prompt = buildStagedWritingPrompt({
      jobId: 'job-merge',
      locale: 'zh-CN',
      topic: 'malware analysis',
      contextText: '用户：根据 malware 分析报告完成论文',
      venue: '',
      sourcePaths: ['sources/'],
      stage: STAGED_WRITING_STAGES[5],
      stageIndex: 5,
      stageTotal: 6,
      outputPath: 'outputs/drafts/malware/manuscript-v1.md',
      priorOutputPaths: ['outputs/drafts/malware/01_introduction.md'],
    });
    expect(prompt).toContain('合并步骤禁止读取源资料');
    expect(prompt).toContain('禁止引入新的主题或资料');
    expect(prompt).not.toContain('允许读取的数据源：\nsources/');
  });

  it('does not allow broad workspace source roots', () => {
    const prompt = buildStagedWritingPrompt({
      jobId: 'job-safe-sources',
      locale: 'zh-CN',
      topic: 'malware analysis',
      contextText: '用户：分析 malware',
      venue: '',
      sourcePaths: ['sources/', 'sources/malware-report.md'],
      stage: STAGED_WRITING_STAGES[0],
      stageIndex: 0,
      stageTotal: 6,
      outputPath: 'outputs/drafts/malware/01_introduction.md',
      priorOutputPaths: [],
    });
    expect(prompt).toContain('sources/malware-report.md');
    expect(prompt).not.toContain('- `sources/`');
  });

  it('countCompletedStages counts done only', () => {
    expect(countCompletedStages([
      { id: 'a', outputPath: 'x', status: 'done' },
      { id: 'b', outputPath: 'y', status: 'failed' },
    ])).toBe(1);
  });

  it('isStagedWritingJobForSession matches normalized session keys only', () => {
    const job = {
      id: 'j1',
      sessionKey: 'project-abc',
      slug: '',
      topic: 't',
      sourcePaths: [],
      venue: '',
      locale: 'en',
      outputDir: 'outputs/drafts',
      startedAtMs: 0,
      status: 'running' as const,
      currentStageIndex: 0,
      stages: [],
      lastError: null,
    };
    expect(isStagedWritingJobForSession(job, 'project-abc')).toBe(true);
    expect(isStagedWritingJobForSession(job, 'agent:main:project-abc')).toBe(true);
    expect(isStagedWritingJobForSession(job, 'main')).toBe(false);
    expect(isStagedWritingJobForSession(job, 'project-other')).toBe(false);
    expect(isStagedWritingJobForSession({ ...job, status: 'cancelled' }, 'project-abc')).toBe(false);
  });

  it('resolveStagedWritingJobSessionKey defaults legacy jobs to main', () => {
    expect(resolveStagedWritingJobSessionKey({
      id: 'j1',
      slug: '',
      topic: 't',
      sourcePaths: [],
      venue: '',
      locale: 'en',
      outputDir: 'outputs/drafts',
      startedAtMs: 0,
      status: 'completed',
      currentStageIndex: 6,
      stages: [],
      lastError: null,
    })).toBe('main');
  });
});
