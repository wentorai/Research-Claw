export type StagedWritingIntentMode = 'start' | 'resume' | 'scan';

export interface StagedWritingIntent {
  mode: StagedWritingIntentMode;
  topic: string;
  slug: string;
  sourcePaths: string[];
  venue: string;
}

const FULL_PAPER_RE =
  /(?:写|撰写|生成|完成|起草|创作|产出)(?:一篇|一个|这篇|该篇)?(?:完整(?:的)?|整篇|全文)?(?:\s*SCI\s*|科研|学术|小|短)?论文|(?:write|generate|produce|draft|complete) (?:a |the )?(?:complete |full |short )?(?:paper|manuscript)/i;

/** Questions / lookup about papers — not a writing request. */
const NOT_WRITING_RE =
  /^(?:什么|啥|请问|介绍|解释|查|搜|找|读|下载)|(?:查|搜|找|读|下载)(?:一)?篇论文|what is (?:a )?paper|search for papers?/i;

const RESUME_RE =
  /^(?:请|帮我)?\s*(?:继续(?:分步)?写作|继续写论文|继续未完成|resume (?:staged )?writing|continue writing)\s*[。.!！]?$/i;

const SCAN_RE =
  /^(?:请|帮我)?\s*(?:扫描已写文件|扫描(?:本地)?草稿|sync saved files|scan written files)\s*[。.!！]?$/i;

const EXPLICIT_RESTART_RE =
  /(?:重新|重启|再次|再来一次|重新开始|restart|start over|rerun).*(?:分步写作|编排|完整(?:的)?(?:小)?论文|full paper|manuscript)/i;

const SINGLE_SECTION_RE =
  /只写|仅写|本轮只|only write|just (?:the )?(introduction|abstract|methods|results|discussion)|write only (?:the )?(introduction|abstract|methods|results|discussion)/i;

const WORKSPACE_PATH_RE =
  /(?:sources|outputs)\/[^\s`"'<>[\]（）()，。！？；：,!?;:]+/gu;

const VENUE_RE =
  /(?:目标期刊|期刊)[：:]\s*([^\n,，。]+)|(?:target venue|journal)[：:]\s*([^\n,，.]+)/i;

export function extractStagedWritingSourcePaths(text: string): string[] {
  const matches = text.match(WORKSPACE_PATH_RE) ?? [];
  return [...new Set(matches.map((p) => p.replace(/^workspace\//, '').replace(/[.。]+$/, '')))];
}

export function isExplicitStagedWritingRestart(text: string): boolean {
  return EXPLICIT_RESTART_RE.test(text.trim());
}

function extractVenue(text: string): string {
  const match = VENUE_RE.exec(text);
  return (match?.[1] ?? match?.[2] ?? '').trim();
}

/** Detect when chat should use built-in Dashboard staged writing instead of one long agent run. */
export function detectStagedWritingIntent(text: string): StagedWritingIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (SINGLE_SECTION_RE.test(trimmed)) return null;

  if (SCAN_RE.test(trimmed)) {
    return {
      mode: 'scan',
      topic: trimmed,
      slug: '',
      sourcePaths: extractStagedWritingSourcePaths(trimmed),
      venue: extractVenue(trimmed),
    };
  }

  if (RESUME_RE.test(trimmed)) {
    return {
      mode: 'resume',
      topic: trimmed,
      slug: '',
      sourcePaths: extractStagedWritingSourcePaths(trimmed),
      venue: extractVenue(trimmed),
    };
  }

  if (trimmed.length < 8) return null;

  if (NOT_WRITING_RE.test(trimmed)) return null;

  if (!FULL_PAPER_RE.test(trimmed)) return null;

  return {
    mode: 'start',
    topic: trimmed,
    slug: '',
    sourcePaths: extractStagedWritingSourcePaths(trimmed),
    venue: extractVenue(trimmed),
  };
}
