/**
 * Preset `models.providers.*` keys allowed for the supervisor reviewer model (Dashboard picker).
 * Actual per-provider adapters are in `src/api-adapters.ts` (`REVIEWER_ADAPTER_BY_PROVIDER`).
 * Keep ids aligned with `dashboard/src/utils/provider-presets.ts`.
 */

export const SUPERVISOR_REVIEWER_PROVIDER_IDS = [
  'zai',
  'zai-global',
  'zai-coding',
  'zai-coding-global',
  'moonshot',
  'moonshot-cn',
  'kimi-coding',
  'minimax',
  'minimax-cn',
] as const;

export type SupervisorReviewerProviderId = (typeof SUPERVISOR_REVIEWER_PROVIDER_IDS)[number];

const _ID_SET = new Set<string>(SUPERVISOR_REVIEWER_PROVIDER_IDS);

export function isSupervisorReviewerProviderId(id: string): id is SupervisorReviewerProviderId {
  return _ID_SET.has(id);
}
