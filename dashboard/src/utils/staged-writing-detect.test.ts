import { describe, it, expect } from 'vitest';
import {
  detectStagedWritingIntent,
  extractStagedWritingSourcePaths,
  isExplicitStagedWritingRestart,
} from './staged-writing-detect';

describe('detectStagedWritingIntent', () => {
  it('detects full paper writing in Chinese', () => {
    const intent = detectStagedWritingIntent(
      '请根据 sources/data.csv 写一篇完整 SCI 论文，目标期刊：Academic Radiology',
    );
    expect(intent?.mode).toBe('start');
    expect(intent?.sourcePaths).toContain('sources/data.csv');
    expect(intent?.venue).toContain('Academic Radiology');
  });

  it('detects 生成一篇小论文 (Session 27 style)', () => {
    const intent = detectStagedWritingIntent('根据这些资料，生成一篇小论文');
    expect(intent?.mode).toBe('start');
  });

  it('detects 写一篇小论文 and 撰写学术论文', () => {
    expect(detectStagedWritingIntent('帮我写一篇小论文')?.mode).toBe('start');
    expect(detectStagedWritingIntent('根据数据撰写学术论文')?.mode).toBe('start');
  });

  it('skips paper lookup / explanation questions', () => {
    expect(detectStagedWritingIntent('查一篇论文关于 TNBC')).toBeNull();
    expect(detectStagedWritingIntent('什么是小论文')).toBeNull();
  });

  it('skips requests that mention a paper but do not ask to draft a full one', () => {
    expect(detectStagedWritingIntent('修改这篇完整论文的标题')).toBeNull();
    expect(detectStagedWritingIntent('分析这篇学术论文有哪些缺点')).toBeNull();
    expect(detectStagedWritingIntent('不要继续写论文')).toBeNull();
  });

  it('detects an explicit request to complete a full short paper', () => {
    expect(detectStagedWritingIntent('根据这些分析，完成一篇完整的小论文')?.mode).toBe('start');
  });

  it('detects resume intent', () => {
    expect(detectStagedWritingIntent('继续分步写作')?.mode).toBe('resume');
  });

  it('detects explicit staged-writing restart wording', () => {
    expect(isExplicitStagedWritingRestart('请重新分步写作一篇完整的小论文')).toBe(true);
    expect(isExplicitStagedWritingRestart('根据修改意见，完成一篇完整的小论文')).toBe(false);
  });

  it('detects scan intent', () => {
    expect(detectStagedWritingIntent('扫描已写文件')?.mode).toBe('scan');
  });

  it('skips single-section requests', () => {
    expect(detectStagedWritingIntent('只写 Introduction 一节')).toBeNull();
  });

  it('skips generic short messages', () => {
    expect(detectStagedWritingIntent('你好')).toBeNull();
  });

  it('extracts explicit source paths from prior session context', () => {
    expect(extractStagedWritingSourcePaths(
      '用户上传了 sources/1-文本攻击-算法设计报告.docx，请基于它分析',
    )).toEqual(['sources/1-文本攻击-算法设计报告.docx']);
  });
});
