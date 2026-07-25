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
  /拦截/,
  /阻断/,
  /重新?生成/,
];

const COURSE_CORRECTION_KEYS = [
  'forceRegenerate',
  'forceRegenerateHint',
  'maxRegenerateAttempts',
  'maxRegenerateAttemptsHint',
  'maxRegenerateAttemptsTooltip',
  'reviewModeCorrect',
  'reviewModeCorrectDesc',
];

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
 * `[^，,。；;]*` in Chinese) instead of testing for keywords independently. A
 * keyword-set check cannot tell "on timeout the call proceeds" from "on timeout
 * the call is still blocked and nothing may proceed" — both contain "timeout",
 * "still", "block" and "proceed". Since the whole point of this file is to stop
 * copy from claiming the opposite of what the code does, an inverted (fail-closed)
 * sentence has to fail here; keyword presence alone lets it through.
 */
const COST_COPY: Record<string, { key: string; required: RegExp[]; forbidden: RegExp[] }[]> = {
  en: [
    {
      // The reviewer runs per model round-trip, and a high-risk tool call adds its
      // own deep review on top — so the copy may not quote a per-turn ceiling.
      key: 'settings.supervisorInheritMainHint',
      required: [/round[- ]?trip/i, /high[- ]risk tool/i, /token/i],
      forbidden: [/per turn/i, /\bexactly\b/i, /\balways\b/i],
    },
    {
      key: 'settings.supervisorToolReviewGateHint',
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
        /nothing\s+(may|can|will)\s+proceed/i,
        /fail[- ]?closed/i,
        /always blocks/i,
        /guarantee/i,
      ],
    },
    {
      // An unusable reviewer must never read as "supervision is off".
      key: 'settings.supervisorReviewerUnavailable',
      required: [/\{\{reason\}\}/, /(deterministic|safety)[^.;]*\bstill\b[^.;]*\brun/i],
      forbidden: [/disabled/i, /turned off/i, /\bnot\s+running\b/i],
    },
    {
      // Same promise on the audit panel — the two surfaces must not disagree.
      key: 'supervisor.reviewerUnavailable',
      required: [/\{\{reason\}\}/, /(deterministic|safety)[^.;]*\bstill\b[^.;]*\brun/i],
      forbidden: [/disabled/i, /turned off/i, /\bnot\s+running\b/i],
    },
  ],
  'zh-CN': [
    {
      key: 'settings.supervisorInheritMainHint',
      required: [/往返/, /高风险工具/, /token|令牌/],
      forbidden: [/每轮/, /固定/],
    },
    {
      key: 'settings.supervisorToolReviewGateHint',
      required: [
        /\{\{seconds\}\}/,
        /超时[^，,。；;]*(放行|继续执行)/,
        /(确定性|安全闸)[^，,。；;]*仍[^，,。；;]*(拦截|阻断)/,
      ],
      forbidden: [
        /超时[^，,。；;]*(拦截|阻断|不予放行|不放行)/,
        /不予放行|不予通过|仍会拦截/,
        /一定会拦截/,
        /保证/,
      ],
    },
    {
      key: 'settings.supervisorReviewerUnavailable',
      required: [/\{\{reason\}\}/, /(确定性|安全闸)[^，,。；;]*仍[^，,。；;]*(运行|工作|生效)/],
      forbidden: [/已关闭/, /已停用/, /(未|不)(再)?(运行|生效)/],
    },
    {
      key: 'supervisor.reviewerUnavailable',
      required: [/\{\{reason\}\}/, /(确定性|安全闸)[^，,。；;]*仍[^，,。；;]*(运行|工作|生效)/],
      forbidden: [/已关闭/, /已停用/, /(未|不)(再)?(运行|生效)/],
    },
  ],
};

describe.each(LOCALES)('%s states the cost of the supervisor settings that have one', (name, bundle) => {
  it.each(COST_COPY[name].map((c) => [c.key, c] as const))('%s is honest about the trade-off', (key, spec) => {
    const [ns, leaf] = key.split('.');
    const value = bundle[ns]?.[leaf];
    expect(value, `${key} is missing`).toBeTypeOf('string');
    for (const re of spec.required) {
      expect(value, `${key} must mention ${re}: "${value}"`).toMatch(re);
    }
    for (const re of spec.forbidden) {
      expect(value, `${key} over-promises (${re}): "${value}"`).not.toMatch(re);
    }
  });
});

describe.each(LOCALES)('%s course-correction copy claims only what the plugin does', (_name, bundle) => {
  it.each(COURSE_CORRECTION_KEYS)('settings.%s promises no blocking or regeneration', (key) => {
    const value = bundle.settings[key];
    expect(value, `settings.${key} is missing`).toBeTypeOf('string');
    for (const claim of FALSE_CLAIMS) {
      expect(value, `settings.${key} claims interception/regeneration: "${value}"`).not.toMatch(claim);
    }
  });

  it('the audit-trail label for a queued correction does not read as a completed rewrite', () => {
    const label = bundle.supervisor.typeForceRegenerate;
    expect(label).toBeTypeOf('string');
    for (const claim of FALSE_CLAIMS) {
      expect(label, `supervisor.typeForceRegenerate claims a rewrite: "${label}"`).not.toMatch(claim);
    }
    expect(label).not.toMatch(/^Regenerate$|^重新生成$/);
  });
});
