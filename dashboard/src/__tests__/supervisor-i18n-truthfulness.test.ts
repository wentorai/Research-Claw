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
