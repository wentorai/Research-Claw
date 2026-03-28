import { normalizeSessionKey } from './session-key';
import { useGatewayStore } from '../stores/gateway';
import { useCronStore } from '../stores/cron';

type CronJobRow = { id?: unknown; sessionKey?: unknown; name?: unknown };

function extractCronJobs(res: unknown): CronJobRow[] {
  if (Array.isArray(res)) {
    return res.filter((j): j is CronJobRow => j !== null && typeof j === 'object');
  }
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    for (const k of ['jobs', 'items', 'cronJobs', 'list', 'data'] as const) {
      const v = o[k];
      if (Array.isArray(v)) {
        const nested = extractCronJobs(v);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
}

/**
 * Stops the gateway cron job tied to a cron:* chat session (if we can resolve it).
 * - `cron:rc-preset:<id>` → Research-Claw preset: deactivate + DB sync (includes cron.remove).
 * - Otherwise → `cron.list` + match by normalized sessionKey, then by job name (strip "Cron: " prefix).
 */
export async function removeScheduledJobForSession(sessionKey: string, displayName: string): Promise<void> {
  const bare = normalizeSessionKey(sessionKey);
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return;

  const presetPrefix = 'cron:rc-preset:';
  if (bare.toLowerCase().startsWith(presetPrefix)) {
    const presetId = bare.slice(presetPrefix.length);
    await useCronStore.getState().deactivatePreset(presetId);
    await useCronStore.getState().loadPresets();
    return;
  }

  const stripCronLabel = (s: string) => s.replace(/^Cron:\s*/i, '').trim();
  const nameGuess = stripCronLabel(displayName);

  try {
    const res = await client.request<unknown>('cron.list', {});
    const jobs = extractCronJobs(res);

    for (const job of jobs) {
      const id = typeof job.id === 'string' ? job.id : '';
      if (!id) continue;
      const jsKey = typeof job.sessionKey === 'string' ? normalizeSessionKey(job.sessionKey) : '';
      if (jsKey && jsKey === bare) {
        try {
          await client.request('cron.remove', { id });
        } catch {
          /* job may already be gone */
        }
        return;
      }
    }

    if (nameGuess) {
      for (const job of jobs) {
        const id = typeof job.id === 'string' ? job.id : '';
        const nm = typeof job.name === 'string' ? job.name : '';
        if (!id || !nm) continue;
        const nmBare = stripCronLabel(nm);
        if (nm === nameGuess || nmBare === nameGuess || nm === displayName) {
          try {
            await client.request('cron.remove', { id });
          } catch {
            /* ignore */
          }
          return;
        }
      }
    }
  } catch {
    /* cron.list missing or failed — caller may still delete the session transcript */
  }
}
