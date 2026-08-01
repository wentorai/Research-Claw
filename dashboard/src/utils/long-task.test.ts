import { describe, expect, it } from 'vitest';

import {
  buildAutoLongTaskPrompt,
  detectLongTaskIntent,
  shouldPromoteLongTaskWithoutConfirmation,
} from './long-task';
import { sanitizeUserMessage } from './sanitize-message';

describe('long task detection', () => {
  it('does not classify an ordinary bulk workspace request as detached work', () => {
    const result = detectLongTaskIntent('帮我批量整理 workspace 里的论文，生成一份报告');
    expect(result.shouldAutoTrack).toBe(false);
    expect(result.reasons).toContain('bulk-scope');
    expect(result.title).toContain('整理 workspace');
  });

  it('detects long-running workspace scan wording for confirmation', () => {
    const result = detectLongTaskIntent('帮我跑一个较长的 workspace 扫描任务');
    expect(result.shouldAutoTrack).toBe(true);
    expect(result.reasons).toContain('duration-hint');
    expect(result.reasons).toContain('bulk-scope');
    expect(result.reasons).toContain('action');
  });

  it('recognizes an explicit numeric duration as a duration hint', () => {
    const result = detectLongTaskIntent('请持续 2 小时批量整理 workspace 里的 100 篇论文并生成报告');
    expect(result.shouldAutoTrack).toBe(true);
    expect(result.reasons).toContain('duration-hint');
    expect(shouldPromoteLongTaskWithoutConfirmation(result)).toBe(false);
  });

  it('never silently promotes heuristic-only long-running workspace work', () => {
    const result = detectLongTaskIntent('帮我跑一个较长的 workspace 扫描任务');
    expect(shouldPromoteLongTaskWithoutConfirmation(result)).toBe(false);
  });

  it('allows silent promotion only for explicit detached/background intent', () => {
    const result = detectLongTaskIntent('请放到后台用子 Agent 扫描整个 workspace');
    expect(shouldPromoteLongTaskWithoutConfirmation(result)).toBe(true);
  });

  it.each([
    '后台任务为什么失败？',
    '后台任务抽屉为什么有这么多刷新按钮？',
    '我想了解后台长任务和前台运行的区别',
    'how does the background task system work?',
  ])('does not treat a discussion or question as an explicit execution command: %s', (message) => {
    const result = detectLongTaskIntent(message);
    expect(result.shouldAutoTrack).toBe(false);
    expect(shouldPromoteLongTaskWithoutConfirmation(result)).toBe(false);
  });

  it('does not auto-track short explanation questions', () => {
    const result = detectLongTaskIntent('为什么 u2 模型没有回复');
    expect(result.shouldAutoTrack).toBe(false);
  });

  it('honors explicit opt-out wording', () => {
    const result = detectLongTaskIntent('不要后台执行，直接回答怎么同步 git');
    expect(result.shouldAutoTrack).toBe(false);
  });

  it('hides internal orchestration instructions from chat history display', () => {
    const prompt = buildAutoLongTaskPrompt({
      jobId: 'longtask:abc',
      title: '批量整理论文',
      originalMessage: '帮我批量整理 workspace 里的论文',
      references: ['papers/a.pdf'],
    });
    expect(prompt).toContain('Research-Claw Job ID: longtask:abc');
    expect(prompt).toContain('not evidence of percent completion');
    expect(prompt).toContain('call job_status before doing any resumed work');
    expect(prompt).toContain('If the Job is already cancelled, stop without resuming');
    expect(prompt).toContain('Earlier stopped or aborted user turns in this session are not pending work');
    expect(prompt).toContain('"the original task" means this exact Job request only');
    expect(prompt).toContain('if it is already terminal, do not call job_finish again');
    expect(prompt).toContain('do not call unrelated tools');
    expect(sanitizeUserMessage(prompt)).toBe('帮我批量整理 workspace 里的论文');
  });
});
