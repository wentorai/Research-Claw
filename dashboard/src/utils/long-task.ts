export interface LongTaskDetection {
  shouldAutoTrack: boolean;
  title: string;
  score: number;
  reasons: string[];
}

interface DetectLongTaskOptions {
  references?: string[];
  hasAttachments?: boolean;
}

interface BuildAutoLongTaskPromptOptions {
  jobId: string;
  title: string;
  originalMessage: string;
  references?: string[];
}

const OPT_OUT_RE = /(?:不要|别|不必|不用).{0,8}(?:后台|长任务|子会话|异步|job|jobs)|(?:直接|马上|立即).{0,8}(?:回答|回复|说)|当前会话里?(?:直接)?(?:做|执行|回答)/i;
const EXPLICIT_BACKGROUND_RE = /后台|长任务|子会话|异步|稍后|持续更新|不用等|不要等|放到\s*jobs?|background|subagent/i;
const DURATION_HINT_RE = /较长|很长|耗时|费时|长时间|久一点|慢慢|大型|复杂|heavy|long[-\s]?running/i;
const BULK_RE = /批量|全量|全部|所有|整个|整站|整库|全项目|workspace|工作区|目录|文件夹|多篇|一批|逐个/i;
const ACTION_RE = /整理|扫描|处理|生成|汇总|归纳|检查|分析|修复|更新|迁移|同步|上传|下载|导出|转换|重构|跑|执行|收集|建立|创建/i;
const ARTIFACT_RE = /论文|文献|报告|清单|索引|数据库|知识库|表格|PPT|幻灯片|数据集|仓库|代码库|日志/i;
const QUESTION_ONLY_RE = /^(为什么|为何|怎么|如何|能否|是否|请问|what|why|how)\b/i;

export function detectLongTaskIntent(message: string, options: DetectLongTaskOptions = {}): LongTaskDetection {
  const text = message.trim();
  const reasons: string[] = [];
  if (!text || OPT_OUT_RE.test(text) || options.hasAttachments) {
    return { shouldAutoTrack: false, title: '', score: 0, reasons };
  }

  let score = 0;
  const hasExplicit = EXPLICIT_BACKGROUND_RE.test(text);
  const hasDurationHint = DURATION_HINT_RE.test(text);
  const hasBulk = BULK_RE.test(text);
  const hasAction = ACTION_RE.test(text);
  const hasArtifact = ARTIFACT_RE.test(text);
  const referenceCount = options.references?.length ?? 0;

  if (hasExplicit) { score += 4; reasons.push('explicit-background'); }
  if (hasDurationHint) { score += 2; reasons.push('duration-hint'); }
  if (hasBulk) { score += 2; reasons.push('bulk-scope'); }
  if (hasAction) { score += 2; reasons.push('action'); }
  if (hasArtifact) { score += 1; reasons.push('artifact'); }
  if (referenceCount >= 3) { score += 2; reasons.push('many-references'); }
  if (text.length >= 80 && hasAction) { score += 1; reasons.push('long-instruction'); }

  if (QUESTION_ONLY_RE.test(text) && !hasExplicit && !(hasBulk && hasAction)) {
    score -= 2;
    reasons.push('question-only');
  }

  const shouldAutoTrack = hasExplicit ? score >= 4 : score >= 5;
  return {
    shouldAutoTrack,
    title: deriveLongTaskTitle(text),
    score,
    reasons,
  };
}

export function shouldPromoteLongTaskWithoutConfirmation(detection: LongTaskDetection): boolean {
  return detection.reasons.includes('explicit-background');
}

export function deriveLongTaskTitle(message: string): string {
  const firstLine = message
    .replace(/^把这个任务作为(?:\s*OpenClaw)?(?:\s*子会话)?后台(?:任务)?执行[:：]?\s*/i, '')
    .replace(/^请?(?:帮我)?(?:批量)?\s*/, '')
    .split(/\r?\n/)[0]
    .trim();
  const compact = firstLine.replace(/\s+/g, ' ');
  if (!compact) return '后台长任务';
  return compact.length > 36 ? `${compact.slice(0, 36)}...` : compact;
}

export function buildAutoLongTaskPrompt(options: BuildAutoLongTaskPromptOptions): string {
  const refs = [...new Set(options.references ?? [])];
  const refText = refs.length > 0 ? refs.join(', ') : 'none';
  return `${options.originalMessage.trim()}

[Research-Claw] Auto Long Task
  - This request has been promoted to a tracked background job.
  - Job ID: ${options.jobId}
  - Job title: ${options.title}
  - Referenced files: ${refText}
  - Do not perform the long-running work in this parent chat turn.
  - First call sessions_spawn with runtime "subagent", a clear taskName, and a self-contained child prompt.
  - The first line of the child prompt must be exactly: Research-Claw Job ID: ${options.jobId}
  - The child must call job_checkpoint with this exact Job ID after each major step and job_finish when done or failed.
  - After sessions_spawn succeeds, save one job_checkpoint for this Job ID saying the OpenClaw child session was started, then return a short confirmation. Do not poll or wait for completion in this parent turn.
  - If sessions_spawn is unavailable, call job_checkpoint with an error for this Job ID and explain the blocker briefly.`;
}
