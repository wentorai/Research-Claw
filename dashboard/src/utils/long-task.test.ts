import { describe, expect, it } from 'vitest';

import {
  buildAutoLongTaskPrompt,
  detectLongTaskIntent,
  shouldPromoteLongTaskWithoutConfirmation,
} from './long-task';
import { sanitizeUserMessage } from './sanitize-message';

describe('long task detection', () => {
  it('detects bulk workspace paper organization as a background task', () => {
    const result = detectLongTaskIntent('帮我批量整理 workspace 里的论文，生成一份报告');
    expect(result.shouldAutoTrack).toBe(true);
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

  it('never silently promotes heuristic-only long-running workspace work', () => {
    const result = detectLongTaskIntent('帮我跑一个较长的 workspace 扫描任务');
    expect(shouldPromoteLongTaskWithoutConfirmation(result)).toBe(false);
  });

  it('allows silent promotion only for explicit detached/background intent', () => {
    const result = detectLongTaskIntent('请放到后台用子 Agent 扫描整个 workspace');
    expect(shouldPromoteLongTaskWithoutConfirmation(result)).toBe(true);
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
    expect(sanitizeUserMessage(prompt)).toBe('帮我批量整理 workspace 里的论文');
  });
});
