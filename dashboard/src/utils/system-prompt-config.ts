import { useGatewayStore } from '../stores/gateway';

const DEBOUNCE_MS = 800;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersisted = '';

/** Read dashboard system-prompt append from openclaw.json (`ui.researchClaw`). */
export function readSystemPromptAppendFromConfig(
  config: Record<string, unknown> | null | undefined,
): string {
  if (!config) return '';
  const ui = config.ui as Record<string, unknown> | undefined;
  const rc = ui?.researchClaw as Record<string, unknown> | undefined;
  const value = rc?.systemPromptAppend;
  return typeof value === 'string' ? value : '';
}

export function buildSystemPromptAppendPatch(text: string): Record<string, unknown> {
  return {
    ui: {
      researchClaw: {
        systemPromptAppend: text.trim(),
      },
    },
  };
}

/** Debounced write to openclaw.json via config.patch (no gateway restart overlay). */
export function schedulePersistSystemPromptAppend(text: string): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void persistSystemPromptAppendToConfig(text);
  }, DEBOUNCE_MS);
}

export async function persistSystemPromptAppendToConfig(text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === lastPersisted) return;

  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return;

  try {
    const snapshot = await client.request<{ hash?: string }>('config.get', {});
    const baseHash = snapshot.hash ?? undefined;
    await client.request('config.patch', {
      raw: JSON.stringify(buildSystemPromptAppendPatch(trimmed)),
      ...(baseHash ? { baseHash } : {}),
      note: 'Update dashboard system prompt append',
    });
    lastPersisted = trimmed;
  } catch (err) {
    console.warn('[config] persistSystemPromptAppend failed:', err);
  }
}

/** Reset debounce/persist cache — for tests. */
export function resetSystemPromptPersistState(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  lastPersisted = '';
}
