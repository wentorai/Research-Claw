import type { GatewayErrorInfo } from '../gateway/types';

const CORE_METHOD_PREFIXES = [
  'rc.app.',
  'rc.cron.',
  'rc.dashboard.',
  'rc.execution.',
  'rc.job.',
  'rc.lit.',
  'rc.model.',
  'rc.monitor.',
  'rc.notifications.',
  'rc.onboarding.',
  'rc.periph.',
  'rc.prompt.',
  'rc.review.',
  'rc.task.',
  'rc.ws.',
];

export interface CoreRuntimeFailure {
  method: string;
  message: string;
  detectedAt: number;
}

export function isCoreMethod(method: string): boolean {
  return CORE_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}

export function classifyCoreMethodFailure(
  method: string,
  error: GatewayErrorInfo,
  now = Date.now(),
  intentionallyUnavailable: (method: string) => boolean = () => false,
): CoreRuntimeFailure | null {
  if (!isCoreMethod(method)) return null;
  if (intentionallyUnavailable(method)) return null;
  if (error.code !== 'INVALID_REQUEST' || !/unknown method:\s*rc\./i.test(error.message)) return null;
  return { method, message: error.message, detectedAt: now };
}

export function isCoreRecoveryProbe(method: string): boolean {
  return method === 'rc.onboarding.status';
}
