import { writingOutputDir } from './staged-writing-run';

export interface StagedWritingStageDef {
  id: string;
  /** i18n key under stagedWriting.stages */
  titleKey: string;
  fileName: string;
  minChars: number;
  timeoutSeconds?: number;
  sectionTitleEn: string;
  sectionTitleZh: string;
}

export const STAGED_WRITING_STAGES: readonly StagedWritingStageDef[] = [
  {
    id: 'introduction',
    titleKey: 'introduction',
    fileName: '01_introduction.md',
    minChars: 600,
    sectionTitleEn: 'Introduction',
    sectionTitleZh: '引言（Introduction）',
  },
  {
    id: 'methods',
    titleKey: 'methods',
    fileName: '02_materials_and_methods.md',
    minChars: 1200,
    sectionTitleEn: 'Materials and Methods',
    sectionTitleZh: '材料与方法（Materials and Methods）',
  },
  {
    id: 'results',
    titleKey: 'results',
    fileName: '03_results.md',
    minChars: 1200,
    sectionTitleEn: 'Results',
    sectionTitleZh: '结果（Results）',
  },
  {
    id: 'discussion',
    titleKey: 'discussion',
    fileName: '04_discussion.md',
    minChars: 1200,
    sectionTitleEn: 'Discussion',
    sectionTitleZh: '讨论（Discussion）',
  },
  {
    id: 'abstract',
    titleKey: 'abstract',
    fileName: '05_abstract.md',
    minChars: 200,
    sectionTitleEn: 'Title and Abstract',
    sectionTitleZh: '标题与摘要（Title and Abstract）',
  },
  {
    id: 'merge',
    titleKey: 'merge',
    fileName: 'manuscript-v1.md',
    minChars: 3000,
    timeoutSeconds: 600,
    sectionTitleEn: 'Merged manuscript (read prior sections, assemble in IMRaD order)',
    sectionTitleZh: '合并稿（读取各节文件，按 IMRaD 顺序合并）',
  },
] as const;

export function stageOutputPath(outputDir: string, fileName: string): string {
  const dir = outputDir.replace(/\/+$/, '');
  return `${dir}/${fileName}`;
}

export function buildInitialStageStates(outputDir: string): Array<{
  id: string;
  outputPath: string;
  status: 'pending';
}> {
  return STAGED_WRITING_STAGES.map((stage) => ({
    id: stage.id,
    outputPath: stageOutputPath(outputDir, stage.fileName),
    status: 'pending' as const,
  }));
}

function isZhLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith('zh');
}

export function buildStagedWritingPrompt(params: {
  jobId: string;
  locale: string;
  topic: string;
  contextText?: string;
  venue: string;
  sourcePaths: string[];
  stage: StagedWritingStageDef;
  stageIndex: number;
  stageTotal: number;
  outputPath: string;
  priorOutputPaths: string[];
}): string {
  const zh = isZhLocale(params.locale);
  const sectionTitle = zh ? params.stage.sectionTitleZh : params.stage.sectionTitleEn;
  const priorList = params.priorOutputPaths.length
    ? params.priorOutputPaths.map((p) => `- \`${p}\``).join('\n')
    : zh ? '（无）' : '(none)';

  const allowedSourcePaths = params.sourcePaths.filter(
    (path) => !/^(?:sources|outputs)\/?$/i.test(path.trim()),
  );
  const sources = allowedSourcePaths.length
    ? allowedSourcePaths.map((p) => `- \`${p}\``).join('\n')
    : zh ? '（未指定 — 仅基于已有草稿）' : '(none — use prior drafts only)';
  const context = params.contextText?.trim()
    || (zh ? '（无可用会话上下文）' : '(no session context available)');
  const isMerge = params.stage.id === 'merge';

  if (zh) {
    return [
      `[rc-writing] 任务 ${params.jobId} · 步骤 ${params.stageIndex + 1}/${params.stageTotal}：${sectionTitle}`,
      '',
      `论文主题：${params.topic}`,
      params.venue ? `目标期刊/格式：${params.venue}` : '',
      '',
      '这是 Dashboard 后台编排的静默任务（无用户对话）。',
      '',
      '硬性要求：',
      `1. 仅用 workspace_read 读取${isMerge ? '下列前序步骤产物' : '下列明确列出的资料与前序步骤产物'}；禁止读取其它 workspace 文件。${isMerge ? '禁止 pdf / exec / pdftotext。' : '若且仅若明确列出的 DOCX 用 workspace_read 返回 base64，可用 exec 调用 pandoc 将该 DOCX 转为文本后读取；禁止用 exec 发现或读取未列出的文件。'}`,
      `2. **只写本节**：${sectionTitle}。${isMerge ? '仅合并和润色前序章节，禁止引入新的主题或资料。' : '禁止写其它章节，禁止一次生成全文。'}`,
      `3. 用 workspace_save 写入 **唯一路径**：\`${params.outputPath}\`（UTF-8 Markdown/LaTeX 片段均可）。`,
      '4. 开始与结束各调用一次 task_flow_stage（status=start / done，带 step/total）。',
      '5. 保存成功后，对话里最多一行确认；不要把正文贴在聊天里。',
      '',
      `所属会话最近上下文（用于理解“这些分析/上述资料”等指代；不得偏离其主题）：\n${context}`,
      '',
      `允许读取的数据源：\n${isMerge ? '（合并步骤禁止读取源资料）' : sources}`,
      '',
      `前序步骤产物（可读）：\n${priorList}`,
    ].filter(Boolean).join('\n');
  }

  return [
    `[rc-writing] Job ${params.jobId} · step ${params.stageIndex + 1}/${params.stageTotal}: ${sectionTitle}`,
    '',
    `Topic: ${params.topic}`,
    params.venue ? `Target venue/format: ${params.venue}` : '',
    '',
    'Silent background job orchestrated by the Dashboard (no user chat).',
    '',
    'Hard requirements:',
    `1. Read ${isMerge ? 'the prior stage files listed below' : 'ONLY the explicitly listed sources and prior stage files'} with workspace_read; do not read any other workspace files. ${isMerge ? 'No pdf / exec / pdftotext.' : 'Only when an explicitly listed DOCX returns base64 from workspace_read, exec may call pandoc to extract that DOCX as text; never use exec to discover or read unlisted files.'}`,
    `2. Write ONLY this section: ${sectionTitle}. ${isMerge ? 'Only merge and polish prior sections; do not introduce a new topic or source.' : 'Do NOT draft other sections or the full paper.'}`,
    `3. workspace_save to exactly: \`${params.outputPath}\` (UTF-8 markdown or LaTeX fragment).`,
    '4. Call task_flow_stage at start and end (status=start / done, with step/total).',
    '5. After save, at most one confirmation line in chat — do not paste section body.',
    '',
    `Recent owning-session context (resolve references such as "these analyses"; do not deviate from its topic):\n${context}`,
    '',
    `Allowed source materials:\n${isMerge ? '(merge step must not read source materials)' : sources}`,
    '',
    `Prior stage outputs (may read):\n${priorList}`,
  ].filter(Boolean).join('\n');
}

export function resolveOutputDir(slug: string): string {
  return writingOutputDir(slug);
}
