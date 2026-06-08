/**
 * Discipline-specific top-venue rubrics for paper review.
 */

export const REVIEW_DISCIPLINES = [
  {
    id: 'cs-ml',
    venues: 'NeurIPS / ICML / ICLR',
    focus: ['创新性', '技术正确性', '理论严谨性', '实验充分性', '消融实验', '统计显著性', '复现性', '实际影响'],
  },
  {
    id: 'cs-vision',
    venues: 'CVPR / ICCV / ECCV',
    focus: ['问题定义与动机', '方法新颖性', '实验基准与对比', '消融与可视化', '计算效率', '泛化能力', '复现性'],
  },
  {
    id: 'cs-nlp',
    venues: 'ACL / EMNLP / NAACL',
    focus: ['语言学合理性', '方法贡献', '实验设计', '人工/自动评测', '错误分析', '数据与伦理', '可复现性'],
  },
  {
    id: 'cs-systems',
    venues: 'OSDI / SOSP / ASPLOS / EuroSys',
    focus: ['系统问题重要性', '设计合理性', '实现与评估', '性能/可扩展性', '可靠性', '与现有工作对比', '开源与复现'],
  },
  {
    id: 'cs-security',
    venues: 'IEEE S&P / USENIX Security / CCS / NDSS',
    focus: ['威胁模型', '攻击/防御有效性', '实验与评测', '实用性', '伦理与负责任披露', '与已知工作对比'],
  },
  {
    id: 'cs-software',
    venues: 'ICSE / FSE / ASE',
    focus: ['研究问题', '方法严谨性', '实证研究设计', '外部有效性', '工具/数据集贡献', '工业相关性'],
  },
  {
    id: 'cs-data',
    venues: 'SIGMOD / VLDB / KDD',
    focus: ['问题与动机', '算法/系统贡献', '理论分析', '实验规模与基准', '效率与可扩展性', '可复现性'],
  },
  {
    id: 'cs-network',
    venues: 'SIGCOMM / NSDI / CoNEXT',
    focus: ['问题重要性', '设计创新', '真实/trace 实验', '性能评估', '部署可行性', '与 SOTA 对比'],
  },
  {
    id: 'cs-theory',
    venues: 'STOC / FOCS / SODA',
    focus: ['问题定义', '主要定理与证明', '技术新颖性', '证明完整性', '与已知结果关系', '开放问题'],
  },
  {
    id: 'biomedical',
    venues: 'Nature Medicine / Lancet / NEJM / Nature Methods',
    focus: ['临床/生物学意义', '研究设计', '统计方法', '样本量与偏倚', '结果可靠性', '伦理合规', '可转化性'],
  },
  {
    id: 'chemistry',
    venues: 'JACS / Angewandte Chemie / Nature Chemistry',
    focus: ['科学问题', '方法创新', '表征完整性', '对照实验', '机理阐释', '可重复合成/测量'],
  },
  {
    id: 'physics',
    venues: 'Physical Review Letters / Nature Physics / Reviews of Modern Physics',
    focus: ['物理意义', '理论/模型', '实验/观测设计', '误差分析', '与现有理论对比', '可检验预测'],
  },
  {
    id: 'economics',
    venues: 'AER / QJE / Econometrica',
    focus: ['研究问题', '识别策略/因果', '模型设定', '数据与测量', '稳健性检验', '政策含义', '文献对话'],
  },
  {
    id: 'general',
    venues: '该领域公认 Top 期刊/会议',
    focus: ['先识别论文所属学科', '再按该领域顶刊标准', '创新性', '方法严谨性', '证据充分性', '写作与结构', '实际影响'],
  },
] as const;

export type ReviewDisciplineId = (typeof REVIEW_DISCIPLINES)[number]['id'];

export const DEFAULT_REVIEW_DISCIPLINE: ReviewDisciplineId = 'cs-ml';

const disciplineMap = new Map(REVIEW_DISCIPLINES.map((d) => [d.id, d]));

export function isReviewDisciplineId(value: string): value is ReviewDisciplineId {
  return disciplineMap.has(value as ReviewDisciplineId);
}

export function getReviewDiscipline(id: ReviewDisciplineId) {
  return disciplineMap.get(id)!;
}

const OUTPUT_SECTIONS = `# Summary

# Main Contributions

# Strengths

# Weaknesses

# Novelty Analysis

# Experimental Analysis

# Statistical Analysis

# Missing Experiments

# Reproducibility

# Top 5 Reject Reasons

# Questions For Authors

# Evidence Sufficiency

# Final Score (1-10)

# Confidence (1-5)

# Accept / Borderline / Reject`;

export function isZhReviewLocale(locale: string): boolean {
  return locale.startsWith('zh');
}

function buildCommonRequirements(locale: string): string {
  if (isZhReviewLocale(locale)) {
    return `要求：

- 报告正文请使用中文撰写（章节标题可保留英文）
- summary、strengths、weaknesses、suggestions 等同步字段也请使用中文
- 优先寻找拒稿理由
- 不要仅复述论文内容
- 所有批评必须有依据，且须标注论文章节
- Weaknesses、Top 5 Reject Reasons、Missing Experiments 中每条批评必须使用格式：\`- [章节名/§X.Y] 观点 — 依据："原文关键句或数据"\`（无章节依据不得写入）
- 区分事实问题和推测问题；推测须标注「推测」
- Evidence Sufficiency 章节首行仅填：sufficient / partial / not_found；随后列出 Coverage（已读章节）与简要说明`;
  }

  return `Requirements:

- Write the report body in English (section headings may stay as shown above)
- Use English for summary, strengths, weaknesses, suggestions, and other fields synced via rc.review.update
- Prioritize finding reasons to reject
- Do not merely restate the paper
- All criticism must cite a paper section and supporting evidence
- In Weaknesses, Top 5 Reject Reasons, and Missing Experiments, every bullet MUST use: \`- [Section/§X.Y] claim — evidence: "key quote or number"\` (omit bullets without section evidence)
- Label speculation explicitly
- In Evidence Sufficiency, first line MUST be: sufficient / partial / not_found; then list Coverage (sections read) and brief notes`;
}

export function buildPaperReviewRubric(
  disciplineId: ReviewDisciplineId = DEFAULT_REVIEW_DISCIPLINE,
  locale: string = 'zh-CN',
): string {
  const discipline = getReviewDiscipline(disciplineId);
  const focusLines = discipline.focus.map((item, index) => `${String.fromCharCode(0x2460 + index)} ${item}`).join('\n');

  if (disciplineId === 'general') {
    return `你是一位跨学科资深审稿人。

请先阅读论文，判断其所属学科领域，并以该领域公认 Top 期刊/会议的标准进行严格评审（${discipline.venues}）。

重点关注：

${focusLines}

${buildCommonRequirements(locale)}

输出：

${OUTPUT_SECTIONS}`;
  }

  return `你是一位 ${discipline.venues} 资深审稿人。

请严格按照上述顶会/顶刊标准评审以下论文。

重点关注：

${focusLines}

${buildCommonRequirements(locale)}

输出：

${OUTPUT_SECTIONS}`;
}

/** @deprecated Use buildPaperReviewRubric('cs-ml') */
export const LEGACY_CS_ML_RUBRIC = buildPaperReviewRubric('cs-ml');
