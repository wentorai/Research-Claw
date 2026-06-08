import type { RegisterMethod } from '../types.js';
import {
  getDashboardSystemPromptAppend,
  setDashboardSystemPromptAppend,
} from './prompt-append.js';

export function registerDashboardRpc(registerMethod: RegisterMethod): void {
  registerMethod('rc.dashboard.setSystemPromptAppend', async (params) => {
    const text = typeof (params as { text?: unknown })?.text === 'string'
      ? (params as { text: string }).text
      : '';
    setDashboardSystemPromptAppend(text);
    return { ok: true };
  });

  registerMethod('rc.dashboard.getSystemPromptAppend', async () => {
    return { text: getDashboardSystemPromptAppend() };
  });
}
