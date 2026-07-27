/**
 * The supervisor never intercepts output.
 *
 * `agent_end` fires after the turn has been delivered and `before_prompt_build`
 * only reaches the NEXT turn, so the `forceRegenerate` option cannot block a
 * response and cannot cause one to be regenerated. Any UI copy promising either
 * is a false claim about what the product does — a user who reads "output will be
 * blocked" will believe unsafe content never reached them.
 *
 * These strings are therefore part of the plugin's honesty contract, not cosmetics.
 */

import { describe, expect, it } from 'vitest';
import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';

type Bundle = Record<string, Record<string, string>>;

const LOCALES = [
  ['en', en as unknown as Bundle],
  ['zh-CN', zh as unknown as Bundle],
] as const;

/** Copy that promises interception or an automatic rewrite of a delivered turn. */
const FALSE_CLAIMS = [
  /\bblock(ed|ing)?\b/i,
  /\bintercept(ed|s)?\b/i,
  /regenerat/i,
  /\b(?:prevent(?:ed|s|ing)?|stop(?:ped|s|ping)?)\b[^.;]*(?:reach(?:ing)?|deliver(?:ed|y|ing)?|see(?:n)?)/i,
  /\b(?:rewrit(?:e|es|ten|ing)|replac(?:e|es|ed|ing))\b/i,
  /拦截/,
  /阻断/,
  /重新?生成/,
  /阻止[^，,。；;]*(?:送达|看到|看见|收到)/,
  /无法[^，,。；;]*(?:送达|看到|看见|收到)/,
  /(?:自动)?(?:改写|替换)/,
];
const FALSE_CLAIM_PROBES = [
  'blocked',
  'intercepted',
  'regenerated',
  'prevented from reaching the user',
  'automatically rewrites the response',
  '拦截',
  '阻断',
  '重新生成',
  '阻止回答送达',
  '回答无法送达',
  '自动改写回答',
] as const;

const COURSE_CORRECTION_KEYS = [
  'forceRegenerate',
  'forceRegenerateHint',
  'maxRegenerateAttempts',
  'maxRegenerateAttemptsHint',
  'maxRegenerateAttemptsTooltip',
  'reviewModeCorrect',
  'reviewModeCorrectDesc',
  // The threshold copy describes when a correction fires, which is exactly the place
  // to overclaim what firing does. Omitting these two left them free to say the
  // deviating answer is "blocked before delivery and automatically regenerated" —
  // the file's flagship lie — while every strictness rule below still passed.
  'deviationThresholdHint',
  'deviationThresholdTooltip',
] as const;

/**
 * C13 — the two supervisor settings that cost the user something must say so.
 *
 * Inheriting the main model is free of configuration, not free of tokens; and the
 * deep-review gate buys latency with a fail-open. Both are honest trade-offs, but
 * only if the copy states them. Note the tension with FALSE_CLAIMS above: the gate
 * hint MUST say the deterministic rules still block, because they really do — what
 * is forbidden elsewhere is claiming that a *delivered output* was blocked.
 *
 * The patterns below deliberately span a whole clause (`[^.;]*` in English,
 * `[^，,。；;]*` in Chinese) instead of testing for keywords independently. That was
 * the first fix, and it was not enough: spanning a clause fixes inverted word ORDER
 * but is blind to NEGATION. "On timeout the tool call does not proceed" satisfies
 * `on timeout … proceeds` just as well as the true sentence does, so a fail-closed
 * lie still passed. Three things guard it now, and no one of them is sufficient:
 *
 *  1. `approved` — the exact wording a human signed off on. Editing a safety-contract
 *     string turns this red, which is the point: re-approval is forced.
 *  2. `required`/`forbidden` — run against the LIVE bundle *and* against `approved`,
 *     so pasting new copy into the constant to un-red a build does not bypass them.
 *  3. `rejects` — a corpus of sentences that mean the OPPOSITE. Every one must fail
 *     the rule set. Without it, rules can rot into vacuous truth and nothing notices.
 *
 * The negation rules below are deliberately over-strict: they reject some sentences
 * that are technically true ("the review does not finish, so the call proceeds").
 * That direction is the safe one — a false red costs a rewording, a false green ships
 * a promise the code does not keep.
 */

/** Negation immediately governing a verb, in the same clause. */
const EN_NEG = String.raw`\b(?:does not|doesn't|do not|don't|will not|won't|would not|wouldn't|cannot|can't|is not|isn't|are not|aren't|never|no longer|not)\b`;
const ZH_NEG = String.raw`(?:不会|不再|不能|不可|不得|不予|无法|禁止|停止|一律不|不)`;
/** "…proceeds" verbs for the gate, "…runs" verbs for the safety gate still being up. */
const EN_PROCEED = String.raw`\b(?:proceeds?|proceed|continues?|continue|is allowed|are allowed|goes through|runs?|executes?)\b`;
const ZH_PROCEED = String.raw`(?:放行|继续执行|继续|执行|通过)`;
const EN_THRESHOLD_SUBJECT = String.raw`\b(?:deviation(?:\s+score)?|deviates?|the\s+score|score|it)\b`;
const EN_STRICT_THRESHOLD = new RegExp(
  `${EN_THRESHOLD_SUBJECT}[^.;!?]*(?:(?<!reaches or )\\bexceeds?\\b|(?<!at or )\\babove\\b|\\b(?:surpass(?:es|ed|ing)?|over|past|beyond|passes?|(?:higher|larger|greater|more)\\s+than)\\b)`,
  'i',
);
const ZH_THRESHOLD_SUBJECT = String.raw`(?:偏离(?:分数)?|该分数|分数|它)`;
const ZH_STRICT_THRESHOLD = new RegExp(
  `${ZH_THRESHOLD_SUBJECT}[^，,。；;!?！？]*(?:(?<!达到或)超过|大过|越过|高出|高过|超出|高于|大于)`,
);
const EN_NEGATED_CORRECTION = /\b(?:does not|doesn't|will not|won't|cannot|can't|never)\s+(?:trigger|run|apply|happen)\b/i;
const ZH_NEGATED_CORRECTION = /(?:不|不会|不能|无法)(?:触发|纠正|处理|生效)/;

const THRESHOLD_SEMANTICS_KEYS = [
  'settings.deviationThresholdHint',
  'settings.deviationThresholdTooltip',
  'settings.maxRegenerateAttemptsTooltip',
] as const;

type CourseCorrectionKey = (typeof COURSE_CORRECTION_KEYS)[number];
type CourseCorrectionApprovedKey = `settings.${CourseCorrectionKey}` | 'supervisor.typeForceRegenerate';

/**
 * These are behavioural promises, so every wording change requires explicit review.
 *
 * Regexes remain useful as a second line of defence and as mutation targets, but they
 * cannot enumerate natural language: "blocks" slipped past an English `block(ed|ing)?`
 * rule, and Chinese "阻止回答送达" needed none of the listed interception words.
 */
const COURSE_CORRECTION_APPROVED = {
  en: {
    'settings.forceRegenerate': 'Strong Correction on Deviation',
    'settings.forceRegenerateHint':
      'When enabled, a deviated turn gets a dedicated corrective instruction injected into the next turn. The delivered output itself is never changed.',
    'settings.maxRegenerateAttempts': 'Max Corrections per Session',
    'settings.maxRegenerateAttemptsHint':
      'Maximum number of corrective instructions queued per session while deviation persists',
    'settings.maxRegenerateAttemptsTooltip':
      'When the deviation reaches or exceeds the threshold and strong correction is enabled, this is the maximum number of corrective instructions queued per session. Past this limit only a warning is recorded.',
    'settings.reviewModeCorrect': 'Course Correction (filter + next-turn guidance)',
    'settings.reviewModeCorrectDesc':
      'Safety filtering + deviation detection + consistency checking + target conclusion tracking',
    'settings.deviationThresholdHint': 'Trigger course correction when the deviation score reaches or exceeds this value',
    'settings.deviationThresholdTooltip':
      "Score from 0-1. When the reviewer model judges that the main model's output deviates from the research goal by at least this much, course correction is triggered. 0.3 = more sensitive, 0.7 = more lenient. Default: 0.5",
    'supervisor.typeForceRegenerate': 'Correction Queued',
  },
  'zh-CN': {
    'settings.forceRegenerate': '偏离后强化纠偏',
    'settings.forceRegenerateHint': '启用后，偏离目标的回答会在下一轮提示中注入一条强制纠偏指令；已发出的内容不会被改动',
    'settings.maxRegenerateAttempts': '每会话最多纠偏次数',
    'settings.maxRegenerateAttemptsHint': '偏离持续时，每次会话最多注入的纠偏指令条数',
    'settings.maxRegenerateAttemptsTooltip': '当偏离达到或超过阈值且开启强化纠偏时，每次会话最多注入的纠偏指令条数。超过此上限后仅记录警告',
    'settings.reviewModeCorrect': '方向纠正（过滤 + 下一轮纠偏）',
    'settings.reviewModeCorrectDesc': '安全检查 + 偏离检测 + 一致性检查 + 目标结论追踪',
    'settings.deviationThresholdHint': '当偏离分数达到或超过此值时触发纠正',
    'settings.deviationThresholdTooltip':
      '0-1 的分数。当 reviewer 模型判断主模型输出偏离研究目标达到或超过此值时，触发课程纠正。0.3 = 较敏感，0.7 = 较宽松。默认 0.5',
    'supervisor.typeForceRegenerate': '已排队纠偏',
  },
} as const satisfies Record<(typeof LOCALES)[number][0], Record<CourseCorrectionApprovedKey, string>>;

const COPY_CONTRACT_KEYS = [
  'settings.supervisorInheritMainHint',
  'settings.supervisorToolReviewGateHint',
  'settings.supervisorReviewerUnavailable',
  'supervisor.reviewerUnavailable',
  ...THRESHOLD_SEMANTICS_KEYS,
] as const;

type CopyContractKey = (typeof COPY_CONTRACT_KEYS)[number];

/**
 * Independent shape pins stop a single rule or reverse fixture from disappearing
 * while loop-driven tests silently collect fewer cases.
 */
const COPY_CONTRACT_SHAPES = {
  en: {
    'settings.supervisorInheritMainHint': { required: 3, forbidden: 5, rejects: 8 },
    'settings.supervisorToolReviewGateHint': { required: 3, forbidden: 8, rejects: 20 },
    'settings.supervisorReviewerUnavailable': { required: 2, forbidden: 4, rejects: 9 },
    'supervisor.reviewerUnavailable': { required: 2, forbidden: 4, rejects: 9 },
    'settings.deviationThresholdHint': { required: 1, forbidden: 3, rejects: 19 },
    'settings.deviationThresholdTooltip': { required: 1, forbidden: 3, rejects: 19 },
    'settings.maxRegenerateAttemptsTooltip': { required: 1, forbidden: 3, rejects: 19 },
  },
  'zh-CN': {
    'settings.supervisorInheritMainHint': { required: 3, forbidden: 5, rejects: 8 },
    'settings.supervisorToolReviewGateHint': { required: 3, forbidden: 7, rejects: 20 },
    'settings.supervisorReviewerUnavailable': { required: 2, forbidden: 4, rejects: 9 },
    'supervisor.reviewerUnavailable': { required: 2, forbidden: 4, rejects: 9 },
    'settings.deviationThresholdHint': { required: 1, forbidden: 3, rejects: 19 },
    'settings.deviationThresholdTooltip': { required: 1, forbidden: 3, rejects: 19 },
    'settings.maxRegenerateAttemptsTooltip': { required: 1, forbidden: 3, rejects: 19 },
  },
} as const satisfies Record<
  (typeof LOCALES)[number][0],
  Record<CopyContractKey, { required: number; forbidden: number; rejects: number }>
>;

const THRESHOLD_FORMAT_VARIANTS = {
  en: [
    'The DEVIATION score REACHES OR EXCEEDS the threshold',
    'The deviation score reaches  or\nexceeds the threshold',
    'At deviation 0.5, the score reaches or exceeds the threshold',
  ],
  'zh-CN': [
    '偏离分数达到或超过阈值',
    '偏离分数达到或\n超过阈值',
    '偏离分数不低于阈值',
  ],
} as const;

/**
 * Paired attacks keep the two locales honest against the same failure modes.
 *
 * A length-only comparison once let the Chinese pronoun attack be replaced by a
 * duplicate while all tests stayed green. Stable IDs make missing categories
 * visible; unique paired strings prevent one side from silently collapsing two
 * categories into one.
 */
const THRESHOLD_ATTACK_PAIRS = [
  {
    id: 'plain_exceeds',
    en: 'Trigger course correction when the deviation score exceeds this value',
    zh: '当偏离分数超过此值时触发纠正',
  },
  {
    id: 'plain_above',
    en: 'Trigger course correction when the deviation score is above this value',
    zh: '当偏离分数高于此值时触发纠正',
  },
  {
    id: 'plain_beyond',
    en: 'Trigger course correction when the deviation score goes beyond this threshold',
    zh: '当偏离分数大于此值时触发纠正',
  },
  {
    id: 'only_exceeds',
    en: 'Correction is triggered only when the deviation exceeds the threshold',
    zh: '仅当偏离分数超过此值时才触发纠正',
  },
  {
    id: 'strict_greater',
    en: 'Correction is triggered when the deviation is strictly greater than the threshold',
    zh: '当偏离分数严格大于此值时触发纠正',
  },
  {
    id: 'parenthetical_launder',
    en: 'Trigger course correction when the deviation score exceeds this value (at least 0.1 recommended)',
    zh: '当偏离分数超过此值时触发纠正(建议不低于 0.1)',
  },
  {
    id: 'conflicting_inclusive_clause',
    en: 'Correction runs when the deviation is greater than the threshold; at or above it nothing happens',
    zh: '当偏离大于阈值时才纠正;达到或超过时不处理',
  },
  {
    id: 'cross_sentence_surpass',
    en: 'The deviation reaches or exceeds the displayed threshold. In actual use, the score must surpass it before correction runs',
    zh: '偏离达到或超过阈值时只做标记。实际上，该分数高过阈值才触发纠正',
  },
  {
    id: 'higher_than',
    en: 'The deviation reaches or exceeds a reference value; correction runs only when the score is higher than the threshold',
    zh: '偏离达到或超过参考值；该分数大过阈值才触发纠正',
  },
  {
    id: 'over',
    en: 'The deviation reaches or exceeds a reference value; correction runs once it is over the threshold',
    zh: '偏离达到或超过参考值；该分数越过阈值才触发纠正',
  },
  {
    id: 'past',
    en: 'The deviation reaches or exceeds a reference value; correction runs after the score goes past the threshold',
    zh: '偏离达到或超过参考值；该分数高出阈值才触发纠正',
  },
  {
    id: 'larger_than',
    en: 'The deviation reaches or exceeds a reference value; correction runs only when it is larger than the threshold',
    zh: '偏离达到或超过参考值；该分数一旦超出阈值才触发纠正',
  },
  {
    id: 'pronoun_subject',
    en: 'The deviation reaches or exceeds a reference value; correction runs once it passes the threshold',
    zh: '偏离达到或超过参考值；它高过阈值才触发纠正',
  },
  {
    id: 'cross_sentence_greater',
    en: 'The deviation reaches or exceeds a reference value. The score must be greater than the threshold',
    zh: '偏离达到或超过参考值。该分数必须大于阈值才触发纠正',
  },
  {
    id: 'decimal_anchor',
    en: 'Deviation reaches or exceeds the documented threshold. At deviation 0.5, the score exceeds the runtime threshold before correction',
    zh: '偏离达到或超过文档阈值。在偏离 0.5 时，该分数高过运行时阈值才触发纠正',
  },
  {
    id: 'decimal_separator',
    en: 'Correction runs only when the deviation reaches or exceeds 0.5 and then exceeds the threshold',
    zh: '纠正仅在偏离达到或超过 0.5 后又高过阈值时触发',
  },
  {
    id: 'negated_correction',
    en: 'Correction does not trigger when the deviation reaches or exceeds the threshold',
    zh: '当偏离达到或超过阈值时不触发纠正',
  },
  {
    id: 'missing_inclusive_threshold',
    en: 'Course correction runs under the configured policy',
    zh: '课程纠正按配置策略触发',
  },
  {
    id: 'global_strictly_greater',
    en: 'The deviation reaches or exceeds the threshold. Another sentence claims a strictly greater policy.',
    zh: '偏离达到或超过阈值时触发纠正。另一句声称必须严格大于。',
  },
] as const;

type CopySpec = {
  key: string;
  /** Exact approved wording for a safety contract; omitted for copy that may be reworded freely. */
  approved?: string;
  required: RegExp[];
  forbidden: RegExp[];
  /** Sentences that invert the contract. Every one must be rejected by required/forbidden. */
  rejects?: string[];
};

const COST_COPY: Record<string, CopySpec[]> = {
  en: [
    {
      // The reviewer runs per model round-trip, and a high-risk tool call adds its
      // own deep review on top — so the copy may not quote a per-turn ceiling.
      key: 'settings.supervisorInheritMainHint',
      approved:
        "No extra API key needed. Full control mode adds several reviewer calls on every model round-trip, plus one deep review per high-risk tool call — all of it spends the main model's calls and token allowance.",
      required: [/round[- ]?trip/i, /high[- ]risk tool/i, /token/i],
      forbidden: [
        /per turn/i,
        /\bexactly\b/i,
        /\balways\b/i,
        /high[- ]risk tool[^.;]*(?:no|not|without)[^.;]*(?:review|call)/i,
        /\b(?:free|no tokens?|without tokens?)\b/i,
      ],
      rejects: [
        'High-risk tool calls add one deep review and spend the main model token allowance.',
        'Full control mode adds reviewer calls on every model round-trip and spends token allowance.',
        'Every model round-trip adds reviewer calls, and high-risk tool calls add one deep review.',
        'Every model round-trip adds reviewer calls; high-risk tool calls add one deep review; token use is accounted per turn.',
        'Every model round-trip adds exactly three reviewer calls; high-risk tool calls add one deep review and spend token allowance.',
        'Every model round-trip always adds reviewer calls; high-risk tool calls add one deep review and spend token allowance.',
        'Every model round-trip adds reviewer calls; high-risk tool calls add no deep review and still spend token allowance.',
        'Every model round-trip adds reviewer calls; high-risk tool calls add a deep review but use no tokens.',
      ],
    },
    {
      key: 'settings.supervisorToolReviewGateHint',
      approved:
        "A high-risk tool call waits up to {{seconds}}s for the reviewer model's deep review. On timeout the deep review is skipped and the call proceeds (recorded in the audit log); the deterministic dangerous-command rules still block it instantly.",
      required: [
        /\{\{seconds\}\}/,
        // on timeout → the call goes through
        /(on timeout|times? out)[^.;]*\b(proceeds?|continues?|is allowed|goes through)\b/i,
        // …but the deterministic rules still stop it
        /deterministic[^.;]*\bstill\b[^.;]*\b(block|stop)/i,
      ],
      forbidden: [
        // fail-closed claims: the gate does NOT hold the call on timeout
        /(on timeout|times? out)[^.;]*\b(blocked|denied|refused|rejected)\b/i,
        // …and it does not hold it by NEGATING the affirmative verb either
        new RegExp(`(on timeout|times? out)[^.;]*${EN_NEG}[^.;]*${EN_PROCEED}`, 'i'),
        // the second half of the contract, inverted: the deterministic rules stand down
        new RegExp(`deterministic[^.;]*${EN_NEG}[^.;]*\\b(block|stop|run|apply)`, 'i'),
        /deterministic[^.;]*\b(skipped|bypassed|suspended|disabled)\b/i,
        /nothing\s+(may|can|will)\s+proceed/i,
        /fail[- ]?closed/i,
        /always blocks/i,
        /guarantee/i,
      ],
      rejects: [
        // The exact fixture that proved the clause-spanning rules were negation-blind.
        'A high-risk tool call waits up to {{seconds}}s. On timeout the tool call does not proceed; deterministic dangerous-command rules still block it instantly.',
        "A high-risk tool call waits up to {{seconds}}s for the reviewer's deep review. On timeout the call will not proceed; the deterministic dangerous-command rules still block it instantly.",
        'Waits up to {{seconds}}s. On timeout the call cannot continue; the deterministic dangerous-command rules still block it instantly.',
        'Waits up to {{seconds}}s. On timeout the call is never allowed through; the deterministic dangerous-command rules still block it instantly.',
        'Waits up to {{seconds}}s. On timeout the call no longer proceeds; the deterministic dangerous-command rules still block it instantly.',
        "Waits up to {{seconds}}s. When it times out the call won't go through; the deterministic dangerous-command rules still block it instantly.",
        'Waits up to {{seconds}}s. On timeout the call is blocked; the deterministic dangerous-command rules still block it instantly.',
        // Second half inverted: the deterministic rules are the part that must never degrade.
        'Waits up to {{seconds}}s. On timeout the deep review is skipped and the call proceeds; the deterministic dangerous-command rules are skipped as well.',
        'Waits up to {{seconds}}s. On timeout the deep review is skipped and the call proceeds; the deterministic dangerous-command rules no longer block it.',
        'Waits up to {{seconds}}s. On timeout the deep review is skipped and the call proceeds; we guarantee nothing dangerous gets through.',
        'Waits up to {{seconds}}s. On timeout nothing may proceed; the deterministic dangerous-command rules still block it.',
        'This gate is fail-closed. It waits up to {{seconds}}s; on timeout the call proceeds and deterministic rules still block it.',
        'The reviewer always blocks the call. It waits up to {{seconds}}s; on timeout the call proceeds and deterministic rules still block it.',
        // Contract silently dropped rather than inverted.
        'A high-risk tool call waits up to {{seconds}}s for the deep review.',
        "On timeout the deep review is skipped and the call proceeds; the deterministic rules still block it instantly.", // no {{seconds}}
        // Each rule below has one witness that all other rules accept. This makes deleting
        // a rule observable even if its shape count is edited at the same time.
        'A high-risk tool call waits up to {{seconds}}s. On timeout the call proceeds.',
        'Waits up to {{seconds}}s. On timeout the reviewer is blocked while the call proceeds; deterministic rules still block it.',
        'Waits up to {{seconds}}s. On timeout the call proceeds; deterministic rules still block it. Deterministic checks do not apply.',
        'Waits up to {{seconds}}s. On timeout the call proceeds; deterministic rules still block it. Deterministic checks are bypassed.',
        'Waits up to {{seconds}}s. On timeout the call proceeds; deterministic rules still block it. This is a guarantee.',
      ],
    },
    {
      // An unusable reviewer must never read as "supervision is off".
      key: 'settings.supervisorReviewerUnavailable',
      approved:
        'AI review is unavailable. Dangerous-command protection is still active. Choose a reviewer model in Supervisor settings, or check its API key and balance.',
      required: [/dangerous-command protection[^.;]*\bstill\b[^.;]*\bactive/i, /(choose|check)[^.;]*(model|API key|balance)/i],
      forbidden: [
        /\bAI review\b[^.;]*\bdisabled\b/i,
        /\bAI review\b[^.;]*turned off/i,
        /models\.providers|available:/i,
        /\bguarantee(?:s|d)?\b/i,
      ],
      rejects: [
        'AI review is unavailable. Dangerous-command protection is still active. Choose a reviewer model in Supervisor settings, or check its API key and balance. models.providers is invalid.',
        'AI review is disabled. Dangerous-command protection is still active. Choose a reviewer model in Supervisor settings, or check its API key and balance.',
        'AI review is turned off. Dangerous-command protection is still active. Choose a reviewer model in Supervisor settings, or check its API key and balance.',
        'AI review is unavailable. Dangerous-command protection is still active and guarantees safety. Choose a reviewer model in Supervisor settings, or check its API key and balance.',
        'AI review is unavailable. Dangerous-command protection is still active. Check the logs.', // no actionable model/key/balance guidance
        'AI review is unavailable. Choose a reviewer model in Supervisor settings.', // protection status dropped
        'AI review is unavailable. Dangerous-command protection is still active.', // no recovery action
        'AI review is unavailable. Dangerous-command protection is not active. Check its API key and balance.',
        'AI review is unavailable. Dangerous-command protection guarantees safety. Choose a reviewer model in Supervisor settings.',
      ],
    },
    {
      // Same promise on the audit panel — the two surfaces must not disagree.
      key: 'supervisor.reviewerUnavailable',
      approved: 'AI review is unavailable. Dangerous-command protection is still active. Open Supervisor settings to choose a reviewer model.',
      required: [/dangerous-command protection[^.;]*\bstill\b[^.;]*\bactive/i, /supervisor settings[^.;]*(choose|model)/i],
      forbidden: [
        /\bAI review\b[^.;]*\bdisabled\b/i,
        /\bAI review\b[^.;]*turned off/i,
        /models\.providers|available:/i,
        /\bguarantee(?:s|d)?\b/i,
      ],
      rejects: [
        'AI review is unavailable. Dangerous-command protection is still active. Open Supervisor settings to choose a reviewer model. models.providers is invalid.',
        'AI review is disabled. Dangerous-command protection is still active. Open Supervisor settings to choose a reviewer model.',
        'AI review is turned off. Dangerous-command protection is still active. Open Supervisor settings to choose a reviewer model.',
        'AI review is unavailable. Dangerous-command protection is still active. Open Supervisor settings to choose a reviewer model. This guarantees safety.',
        'AI review is unavailable. Open Supervisor settings to choose a reviewer model.',
        'AI review is unavailable. Dangerous-command protection is still active.',
        'AI review is unavailable. Dangerous-command protection is not active. Open settings.',
        'AI review is unavailable. Dangerous-command protection is still active. Choose a reviewer model.',
        'AI review is unavailable. Dangerous-command protection guarantees safety. Open Supervisor settings.',
      ],
    },
    // The threshold comparison is `>=` (course-corrector.ts), so a deviation exactly
    // equal to the threshold DOES trigger correction. Reviewer models emit round scores
    // constantly, and the slider's step is 0.1 — equality is a case users actually hit,
    // not a rounding curiosity. Copy saying "exceeds" describes a `>` this code no longer
    // uses.
    //
    // Both halves are bound to the clause that mentions the deviation, and both are
    // needed. The first version of this rule required an inclusive marker anywhere in
    // the string and banned nothing that a plain "exceeds" would trip, on the reasoning
    // that the honest wording ("reaches or exceeds") contains that word too. A whole-
    // string `required` only asks that the marker appear SOMEWHERE, so
    // "…when the deviation score exceeds this value (at least 0.1 recommended)" — the
    // strict claim, laundered by an unrelated parenthetical — satisfied it and shipped
    // green. The marker now has to sit in the same clause as the deviation, and the
    // strict verbs are banned in that clause unless they are the tail of the inclusive
    // phrase. The lookbehinds are what let "reaches or exceeds" and "at or above"
    // through while "score exceeds" and "is above" are caught.
    ...(THRESHOLD_SEMANTICS_KEYS.map((key) => ({
      key,
      approved: COURSE_CORRECTION_APPROVED.en[key],
      required: [/deviat(?:ion|es)[^.;]*\b(?:reaches or exceeds|at or above|at least)\b/i],
      forbidden: [EN_STRICT_THRESHOLD, EN_NEGATED_CORRECTION, /\bstrictly (greater|above|more)\b/i],
      rejects: THRESHOLD_ATTACK_PAIRS.map(({ en: attack }) => attack),
    })) as CopySpec[]),
  ],
  'zh-CN': [
    {
      key: 'settings.supervisorInheritMainHint',
      approved: '无需另配 API Key。完整管控模式会在每次模型往返时追加数次审查调用，并对每个高风险工具调用追加一次深审，全部消耗主模型的调用与 token 额度。',
      required: [/往返/, /高风险工具/, /token|令牌/],
      forbidden: [
        /每轮/,
        /固定/,
        /总是|始终|一律/,
        /高风险工具[^，,。；;]*(?:不|没有|无需)[^，,。；;]*(?:深审|审查|调用)/,
        /(?:不消耗|无需|免费)[^，,。；;]*(?:token|令牌)/i,
      ],
      rejects: [
        '高风险工具会追加一次深审，并消耗主模型 token 额度。',
        '完整管控模式会在每次模型往返时追加审查调用，并消耗主模型 token 额度。',
        '每次模型往返会追加审查调用，高风险工具也会追加一次深审。',
        '每次模型往返会追加审查调用，高风险工具也会追加一次深审，token 消耗按每轮计算。',
        '每次模型往返固定追加三次审查调用，高风险工具也会追加一次深审，并消耗 token 额度。',
        '每次模型往返总是追加审查调用，高风险工具也会追加一次深审，并消耗 token 额度。',
        '每次模型往返会追加审查调用，高风险工具不追加深审，全部消耗主模型 token 额度。',
        '每次模型往返会追加审查调用，高风险工具也追加深审，但不消耗 token 额度。',
      ],
    },
    {
      key: 'settings.supervisorToolReviewGateHint',
      approved: '高风险工具深审最多等待 {{seconds}} 秒；超时后深审降级并放行（记入审计日志），但确定性危险规则仍即时拦截。',
      required: [
        /\{\{seconds\}\}/,
        /超时[^，,。；;]*(放行|继续执行)/,
        /(确定性|安全闸)[^，,。；;]*仍[^，,。；;]*(拦截|阻断)/,
      ],
      forbidden: [
        /超时[^，,。；;]*(拦截|阻断|不予放行|不放行)/,
        // 否定语义:「超时后**不会**继续执行」与「超时后继续执行」在关键词层面无法区分
        new RegExp(`超时[^，,。；;]*${ZH_NEG}[^，,。；;]*${ZH_PROCEED}`),
        // 契约后半段被反转:确定性规则本身停摆
        new RegExp(`(确定性|安全闸)[^，,。；;]*${ZH_NEG}[^，,。；;]*(拦截|阻断|运行|生效)`),
        /(确定性|安全闸)[^，,。；;]*(跳过|略过|停用|关闭)/,
        /不予放行|不予通过|仍会拦截/,
        /一定会拦截/,
        /保证/,
      ],
      rejects: [
        // 评审给出的原始反例:与真实文案在关键词层面完全一致,语义相反。
        '高风险工具深审最多等待 {{seconds}} 秒；超时后不会继续执行；确定性危险规则仍即时拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后不放行；确定性危险规则仍即时拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后无法继续执行；确定性危险规则仍即时拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后禁止继续执行；确定性危险规则仍即时拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后不再放行；确定性危险规则仍即时拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后仍会拦截；确定性危险规则仍即时拦截。',
        // 后半段反转:确定性规则才是绝不可降级的那一半
        '高风险工具深审最多等待 {{seconds}} 秒；超时后深审降级并放行，确定性危险规则也会被跳过。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后深审降级并放行，确定性危险规则不再拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后深审降级并放行，保证不会有危险命令通过。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后一定会拦截；确定性危险规则仍即时拦截。',
        // 契约被静默删掉,而非反转
        '高风险工具深审最多等待 {{seconds}} 秒。',
        '超时后深审降级并放行（记入审计日志），但确定性危险规则仍即时拦截。', // 缺 {{seconds}}
        // 下列每条反例只由一条规则拒绝；即便同步下调 shape 数量，删除该规则也会
        // 让对应反例漏过最终的全量拒绝断言。
        '高风险工具深审最多等待 {{seconds}} 秒；确定性危险规则仍即时拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后深审降级并放行。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后审查器拦截日志后放行；确定性危险规则仍即时阻断。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后放行；确定性危险规则仍即时拦截。安全闸不能生效。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后放行；确定性危险规则仍即时拦截。安全闸会被跳过。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后放行；确定性危险规则仍即时拦截。审查结果不予通过。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后放行；确定性危险规则仍即时拦截。一定会拦截。',
        '高风险工具深审最多等待 {{seconds}} 秒；超时后放行；确定性危险规则仍即时拦截。这是保证。',
      ],
    },
    {
      key: 'settings.supervisorReviewerUnavailable',
      approved: 'AI 深度复核暂未启动，危险命令保护仍正常工作。请重新选择监督模型，或检查该模型的 API 密钥和余额。',
      required: [/危险命令保护[^，,。；;]*仍[^，,。；;]*(工作|生效|运行)/, /(选择|检查)[^，,。；;]*(模型|API 密钥|余额)/],
      forbidden: [
        /AI 深度复核[^，,。；;]*已关闭/,
        /AI 深度复核[^，,。；;]*已停用/,
        /models\.providers|available:|reviewer/,
        /保证|一定/,
      ],
      rejects: [
        'AI 深度复核暂未启动，危险命令保护仍正常工作。请重新选择监督模型，或检查该模型的 API 密钥和余额。models.providers 配置错误。',
        'AI 深度复核已关闭，危险命令保护仍正常工作。请重新选择监督模型，或检查该模型的 API 密钥和余额。',
        'AI 深度复核已停用，危险命令保护仍正常工作。请重新选择监督模型，或检查该模型的 API 密钥和余额。',
        'AI 深度复核暂未启动，危险命令保护一定正常工作。请重新选择监督模型，或检查该模型的 API 密钥和余额。',
        'AI 深度复核暂未启动，危险命令保护仍正常工作。请查看日志。',
        'AI 深度复核暂未启动。请重新选择监督模型，或检查该模型的 API 密钥和余额。',
        'AI 深度复核暂未启动，危险命令保护仍正常工作。',
        'AI 深度复核暂未启动，危险命令保护未正常工作。请检查模型余额。',
        'AI 深度复核暂未启动，危险命令保护仍正常工作。请重新选择监督模型。此能力保证安全。',
      ],
    },
    {
      key: 'supervisor.reviewerUnavailable',
      approved: 'AI 深度复核暂未启动，危险命令保护仍正常工作。请在 Supervisor 设置中重新选择监督模型。',
      required: [/危险命令保护[^，,。；;]*仍[^，,。；;]*(工作|生效|运行)/, /Supervisor 设置[^，,。；;]*(选择|模型)/],
      forbidden: [
        /AI 深度复核[^，,。；;]*已关闭/,
        /AI 深度复核[^，,。；;]*已停用/,
        /models\.providers|available:|reviewer/,
        /保证|一定/,
      ],
      rejects: [
        'AI 深度复核暂未启动，危险命令保护仍正常工作。请在 Supervisor 设置中重新选择监督模型。models.providers 配置错误。',
        'AI 深度复核已关闭，危险命令保护仍正常工作。请在 Supervisor 设置中重新选择监督模型。',
        'AI 深度复核已停用，危险命令保护仍正常工作。请在 Supervisor 设置中重新选择监督模型。',
        'AI 深度复核暂未启动，危险命令保护仍正常工作。请在 Supervisor 设置中重新选择监督模型。此能力保证安全。',
        'AI 深度复核暂未启动。请在 Supervisor 设置中重新选择监督模型。',
        'AI 深度复核暂未启动，危险命令保护仍正常工作。',
        'AI 深度复核暂未启动，危险命令保护未正常工作。请打开设置。',
        'AI 深度复核暂未启动，危险命令保护仍正常工作。请重新选择监督模型。',
        'AI 深度复核暂未启动，危险命令保护一定正常工作。请打开 Supervisor 设置。',
      ],
    },
    // 同上:比较是 `>=`,偏离分数正好等于阈值也会触发纠正。
    // 与英文侧同因同修:原规则只要求"达到或超过"出现在整串的任意位置,于是
    // "当偏离分数超过此值时触发纠正(建议不低于 0.1)"——被无关括号洗白的严格语义
    // ——照样通过。现在标记词必须与"偏离"同处一个子句,严格词也只在该子句内被禁,
    // 且用后行断言放过"达到或超过"这一合法尾巴。
    ...(THRESHOLD_SEMANTICS_KEYS.map((key) => ({
      key,
      approved: COURSE_CORRECTION_APPROVED['zh-CN'][key],
      required: [/偏离[^，,。；;]*(?:达到或超过|不低于)/],
      forbidden: [ZH_STRICT_THRESHOLD, ZH_NEGATED_CORRECTION, /严格大于/],
      rejects: THRESHOLD_ATTACK_PAIRS.map(({ zh: attack }) => attack),
    })) as CopySpec[]),
  ],
};

function normalizeCopy(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/(?<=\d)\.(?=\d)/g, '∯')
    .replace(/\s+/g, ' ')
    .replace(/达到或\s+超过/g, '达到或超过')
    .trim();
}

/** Every rule the spec puts on a string, as a list of human-readable violations. */
function violations(spec: CopySpec, value: string): string[] {
  const normalized = normalizeCopy(value);
  const out: string[] = [];
  for (const re of spec.required) if (!re.test(normalized)) out.push(`missing ${re}`);
  for (const re of spec.forbidden) if (re.test(normalized)) out.push(`over-promises ${re}`);
  return out;
}

it('keeps both translation bundles under the truthfulness guard', () => {
  expect(LOCALES.map(([name]) => name)).toEqual(['en', 'zh-CN']);
});

it('keeps every rule-driving key and formatting corpus under an independent guard', () => {
  expect(COPY_CONTRACT_KEYS).toEqual([
    'settings.supervisorInheritMainHint',
    'settings.supervisorToolReviewGateHint',
    'settings.supervisorReviewerUnavailable',
    'supervisor.reviewerUnavailable',
    'settings.deviationThresholdHint',
    'settings.deviationThresholdTooltip',
    'settings.maxRegenerateAttemptsTooltip',
  ]);
  expect(COURSE_CORRECTION_KEYS).toEqual([
    'forceRegenerate',
    'forceRegenerateHint',
    'maxRegenerateAttempts',
    'maxRegenerateAttemptsHint',
    'maxRegenerateAttemptsTooltip',
    'reviewModeCorrect',
    'reviewModeCorrectDesc',
    'deviationThresholdHint',
    'deviationThresholdTooltip',
  ]);
  expect(THRESHOLD_SEMANTICS_KEYS).toEqual([
    'settings.deviationThresholdHint',
    'settings.deviationThresholdTooltip',
    'settings.maxRegenerateAttemptsTooltip',
  ]);
  expect(THRESHOLD_FORMAT_VARIANTS.en).toEqual([
    'The DEVIATION score REACHES OR EXCEEDS the threshold',
    'The deviation score reaches  or\nexceeds the threshold',
    'At deviation 0.5, the score reaches or exceeds the threshold',
  ]);
  expect(THRESHOLD_FORMAT_VARIANTS['zh-CN']).toEqual([
    '偏离分数达到或超过阈值',
    '偏离分数达到或\n超过阈值',
    '偏离分数不低于阈值',
  ]);
});

it('keeps every known interception and rewrite claim detectable', () => {
  expect(FALSE_CLAIM_PROBES).toEqual([
    'blocked',
    'intercepted',
    'regenerated',
    'prevented from reaching the user',
    'automatically rewrites the response',
    '拦截',
    '阻断',
    '重新生成',
    '阻止回答送达',
    '回答无法送达',
    '自动改写回答',
  ]);
  for (const probe of FALSE_CLAIM_PROBES) {
    expect(FALSE_CLAIMS.some((claim) => claim.test(probe)), `no FALSE_CLAIMS rule rejects "${probe}"`).toBe(true);
  }
});

describe.each(LOCALES)('%s states the cost of the supervisor settings that have one', (name, bundle) => {
  it.each(COST_COPY[name].map((c) => [c.key, c] as const))('%s is honest about the trade-off', (key, spec) => {
    const [ns, leaf] = key.split('.');
    const value = bundle[ns]?.[leaf];
    expect(value, `${key} is missing`).toBeTypeOf('string');
    expect(violations(spec, value), `${key}: "${value}"`).toEqual([]);
  });

  it('every copy contract keeps approved wording, rules, and reverse fixtures', () => {
    for (const key of COPY_CONTRACT_KEYS) {
      const spec = COST_COPY[name].find((c) => c.key === key);
      const shape = COPY_CONTRACT_SHAPES[name][key];
      expect(spec, `${key} has no spec in COST_COPY.${name}`).toBeDefined();
      expect(spec!.approved, `${key} lost its approved wording`).toBeTypeOf('string');
      expect(spec!.required.length, `${key} required-rule count changed`).toBe(shape.required);
      expect(spec!.forbidden.length, `${key} forbidden-rule count changed`).toBe(shape.forbidden);
      expect(spec!.rejects?.length, `${key} reverse-fixture count changed`).toBe(shape.rejects);
      expect(new Set(spec!.required.map(String)).size, `${key} has duplicate required rules`).toBe(spec!.required.length);
      expect(new Set(spec!.forbidden.map(String)).size, `${key} has duplicate forbidden rules`).toBe(spec!.forbidden.length);
      expect(new Set(spec!.rejects).size, `${key} has duplicate reverse fixtures`).toBe(spec!.rejects!.length);
    }
  });

  it('every individual rule has an exclusive reverse witness', () => {
    const unguarded: string[] = [];
    for (const key of COPY_CONTRACT_KEYS) {
      const spec = COST_COPY[name].find((candidate) => candidate.key === key)!;
      spec.required.forEach((rule, index) => {
        const withoutRule = { ...spec, required: spec.required.filter((_, candidate) => candidate !== index) };
        const hasExclusiveWitness = spec.rejects!.some((claim) => violations(withoutRule, claim).length === 0);
        if (!hasExclusiveWitness) unguarded.push(`${key}.required[${index}] ${rule}`);
      });
      spec.forbidden.forEach((rule, index) => {
        const withoutRule = { ...spec, forbidden: spec.forbidden.filter((_, candidate) => candidate !== index) };
        const hasExclusiveWitness = spec.rejects!.some((claim) => violations(withoutRule, claim).length === 0);
        if (!hasExclusiveWitness) unguarded.push(`${key}.forbidden[${index}] ${rule}`);
      });
    }
    expect(unguarded, `${name}: rules without an exclusive reverse witness`).toEqual([]);
  });

  it('threshold rules are stable across case, whitespace, newlines, and decimals', () => {
    const spec = COST_COPY[name].find((c) => c.key === 'settings.deviationThresholdHint');
    expect(spec).toBeDefined();
    for (const value of THRESHOLD_FORMAT_VARIANTS[name]) {
      expect(violations(spec!, value), value).toEqual([]);
    }
  });

  it.each(COST_COPY[name].filter((c) => c.approved).map((c) => [c.key, c] as const))(
    '%s still says exactly what was approved',
    (key, spec) => {
      const [ns, leaf] = key.split('.');
      // A safety-contract string is not free copy. Rewording it must fail here so a
      // human re-approves the new sentence instead of a regex waving it through.
      expect(bundle[ns]?.[leaf]).toBe(spec.approved);
    },
  );

  it.each(COST_COPY[name].filter((c) => c.approved).map((c) => [c.key, c] as const))(
    '%s: the approved wording is itself subject to the rules',
    (key, spec) => {
      // Otherwise `approved` becomes the bypass: paste inverted copy into both the
      // bundle and the constant and every other assertion here goes quiet.
      expect(violations(spec, spec.approved!), key).toEqual([]);
    },
  );

  it.each(COST_COPY[name].filter((c) => c.rejects?.length).map((c) => [c.key, c] as const))(
    '%s: every sentence that inverts the contract is rejected',
    (key, spec) => {
      // This is the guard that has to hold when the rules are next edited. Each of
      // these reads plausibly and shares nearly all its keywords with the approved
      // wording; the two marked in the list are the ones that actually shipped past
      // the previous rule set.
      const accepted = spec.rejects!.filter((s) => violations(spec, s).length === 0);
      expect(accepted, `${key}: these inverted strings were accepted`).toEqual([]);
    },
  );
});

it('keeps the English and Chinese threshold attack corpora paired and complete', () => {
  expect(THRESHOLD_ATTACK_PAIRS.map(({ id }) => id)).toEqual([
    'plain_exceeds',
    'plain_above',
    'plain_beyond',
    'only_exceeds',
    'strict_greater',
    'parenthetical_launder',
    'conflicting_inclusive_clause',
    'cross_sentence_surpass',
    'higher_than',
    'over',
    'past',
    'larger_than',
    'pronoun_subject',
    'cross_sentence_greater',
    'decimal_anchor',
    'decimal_separator',
    'negated_correction',
    'missing_inclusive_threshold',
    'global_strictly_greater',
  ]);
  expect(new Set(THRESHOLD_ATTACK_PAIRS.map(({ en: attack }) => attack)).size).toBe(THRESHOLD_ATTACK_PAIRS.length);
  expect(new Set(THRESHOLD_ATTACK_PAIRS.map(({ zh: attack }) => attack)).size).toBe(THRESHOLD_ATTACK_PAIRS.length);

  const attacksById = new Map(THRESHOLD_ATTACK_PAIRS.map((attack) => [attack.id, attack] as const));
  expect(attacksById.get('cross_sentence_surpass')?.en).toMatch(/\.\s+[^.]*\bsurpass/i);
  expect(attacksById.get('cross_sentence_surpass')?.zh).toMatch(/。[^。]*高过/);
  expect(attacksById.get('higher_than')?.en).toMatch(/\bhigher\s+than\b/i);
  expect(attacksById.get('higher_than')?.zh).toMatch(/大过/);
  expect(attacksById.get('over')?.en).toMatch(/\bover\b/i);
  expect(attacksById.get('over')?.zh).toMatch(/越过/);
  expect(attacksById.get('past')?.en).toMatch(/\bpast\b/i);
  expect(attacksById.get('past')?.zh).toMatch(/高出/);
  expect(attacksById.get('larger_than')?.en).toMatch(/\blarger\s+than\b/i);
  expect(attacksById.get('larger_than')?.zh).toMatch(/超出/);
  expect(attacksById.get('pronoun_subject')?.en).toMatch(/\bit\b/i);
  expect(attacksById.get('pronoun_subject')?.zh).toMatch(/它/);
  expect(attacksById.get('decimal_anchor')?.en).toMatch(/\b0\.5\b/);
  expect(attacksById.get('decimal_anchor')?.zh).toMatch(/\b0\.5\b/);

  for (const key of THRESHOLD_SEMANTICS_KEYS) {
    const enSpec = COST_COPY.en.find((spec) => spec.key === key);
    const zhSpec = COST_COPY['zh-CN'].find((spec) => spec.key === key);
    expect(enSpec?.rejects, `${key} English attack corpus`).toEqual(
      THRESHOLD_ATTACK_PAIRS.map(({ en: attack }) => attack),
    );
    expect(zhSpec?.rejects, `${key} Chinese attack corpus`).toEqual(
      THRESHOLD_ATTACK_PAIRS.map(({ zh: attack }) => attack),
    );
  }
});

describe.each(LOCALES)('%s course-correction copy claims only what the plugin does', (name, bundle) => {
  it.each(COURSE_CORRECTION_KEYS)('settings.%s promises no blocking or regeneration', (key) => {
    const value = bundle.settings[key];
    const approvedKey = `settings.${key}` as `settings.${CourseCorrectionKey}`;
    expect(value, `settings.${key} is missing`).toBeTypeOf('string');
    expect(value, `settings.${key} changed without behavioural-copy review`).toBe(
      COURSE_CORRECTION_APPROVED[name][approvedKey],
    );
    for (const claim of FALSE_CLAIMS) {
      expect(value, `settings.${key} claims interception/regeneration: "${value}"`).not.toMatch(claim);
    }
    const strictThresholdClaim = name === 'en' ? EN_STRICT_THRESHOLD : ZH_STRICT_THRESHOLD;
    expect(normalizeCopy(value), `settings.${key} claims a strict threshold: "${value}"`).not.toMatch(strictThresholdClaim);
  });

  it('the audit-trail label for a queued correction does not read as a completed rewrite', () => {
    const label = bundle.supervisor.typeForceRegenerate;
    expect(label).toBeTypeOf('string');
    expect(label, 'supervisor.typeForceRegenerate changed without behavioural-copy review').toBe(
      COURSE_CORRECTION_APPROVED[name]['supervisor.typeForceRegenerate'],
    );
    for (const claim of FALSE_CLAIMS) {
      expect(label, `supervisor.typeForceRegenerate claims a rewrite: "${label}"`).not.toMatch(claim);
    }
    expect(label).not.toMatch(/^Regenerate$|^重新生成$/);
  });
});
