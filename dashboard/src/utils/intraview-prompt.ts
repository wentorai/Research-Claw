/**
 * IntraView mode — content-grounded Q&A over a single library paper (IntrAgent-style).
 */

import type { Paper } from '../stores/library';
import { isZhReviewLocale } from './paper-review-discipline';

export function resolvePaperReadPath(paper: Paper): string | null {
  const path = paper.pdf_path?.trim();
  return path || null;
}

export function buildIntraViewPrompt(
  paper: Paper,
  question: string,
  locale: string = 'zh-CN',
): string {
  const q = question.trim();
  const readPath = resolvePaperReadPath(paper);
  const authors = paper.authors?.length ? paper.authors.join(', ') : '—';
  const abstract = paper.abstract?.trim() ?? '';
  const abstractSnippet = abstract.slice(0, 800);
  const abstractSuffix = abstract.length > 800 ? '…' : '';

  if (isZhReviewLocale(locale)) {
    const sourceLine = readPath
      ? `- 全文路径：\`${readPath}\`（请用 workspace_read 分段读取；不要使用 pdf 工具）`
      : `- 全文：未关联本地 PDF${
        paper.url ? `；可尝试 url: ${paper.url}` : ''
      }${paper.arxiv_id ? `；arXiv: ${paper.arxiv_id}` : ''}（若无 workspace 文件，请基于摘要作答并说明无法引用章节）`;

    return `【IntraView 文献精读】请仅基于下列论文回答研究问题，禁止用外部知识补全未在文中出现的细节。

论文信息：
- 标题：${paper.title}
- 作者：${authors}
- 年份：${paper.year ?? '—'}
- 文献库 ID：${paper.id}
${paper.doi ? `- DOI：${paper.doi}` : ''}
${sourceLine}
${abstractSnippet ? `- 摘要（辅助）：${abstractSnippet}${abstractSuffix}` : ''}

研究问题：
${q}

执行流程（IntrAgent 风格）：
1. **章节排序**：读取全文后，列出论文章节/小节结构，按与问题的相关度给出阅读顺序。
2. **迭代阅读**：按顺序逐节提取与问题相关的术语、数值、实验设置、结论；每读完一节做「信息充分性检查」。
3. **停止条件**：证据足以回答问题则停止；若读完全文仍不足，在 Answer 中明确写「文中未找到相关信息」。
4. **回答格式（请使用中文）**：
   - **Answer**：简洁准确的回答
   - **Evidence**：每条依据标注章节（如 Methods / §3.2）并引用原文关键句
   - **Coverage**：已读章节列表
   - **Confidence**：high / partial / not_found
5. 不要编造文中不存在的内容；推测须标注为推测。`;
  }

  const sourceLine = readPath
    ? `- Full text path: \`${readPath}\` (read with workspace_read in sections; do not use the pdf tool)`
    : `- Full text: no local PDF linked${
      paper.url ? `; url: ${paper.url}` : ''
    }${paper.arxiv_id ? `; arXiv: ${paper.arxiv_id}` : ''} (if no workspace file, answer from abstract only and note missing sections)`;

  return `[IntraView] Answer the research question using ONLY the paper below. Do not fill gaps with outside knowledge.

Paper:
- Title: ${paper.title}
- Authors: ${authors}
- Year: ${paper.year ?? '—'}
- Library ID: ${paper.id}
${paper.doi ? `- DOI: ${paper.doi}` : ''}
${sourceLine}
${abstractSnippet ? `- Abstract (auxiliary): ${abstractSnippet}${abstractSuffix}` : ''}

Research question:
${q}

Workflow (IntrAgent-style):
1. **Section ranking**: After reading the paper, list sections and order them by relevance to the question.
2. **Iterative reading**: Read ranked sections sequentially; extract anchored evidence; run a sufficiency check after each section.
3. **Stop rule**: Stop when evidence is sufficient; if the full paper is insufficient, state "not found in paper".
4. **Response format (English)**:
   - **Answer**: concise and accurate
   - **Evidence**: section label + quoted supporting text for each claim
   - **Coverage**: sections read
   - **Confidence**: high / partial / not_found
5. Do not invent content not present in the paper; label speculation explicitly.`;
}

/** User-visible question + hidden [Research-Claw] block for agent instructions. */
export function buildIntraViewSendPayload(
  paper: Paper,
  question: string,
  locale: string = 'zh-CN',
): { agentMessage: string; displayText: string } {
  const displayText = question.trim();
  const instructions = buildIntraViewPrompt(paper, displayText, locale);
  const hiddenBlock = [
    '[Research-Claw] IntraView',
    ...instructions.split('\n').map((line) => `  - ${line}`),
  ].join('\n');

  return {
    agentMessage: `${displayText}\n\n${hiddenBlock}`,
    displayText,
  };
}
