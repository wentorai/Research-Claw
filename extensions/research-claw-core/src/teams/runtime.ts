import type { GroupRuntime } from './collaboration.js';

/** Use the host's authenticated gateway and normal tool-backed execution path. */
export function createGroupRuntime(getConfig: () => Record<string, unknown> = () => ({})): GroupRuntime {
  function assertLocalGateway() {
    const gateway = getConfig().gateway as { mode?: string } | undefined;
    if (gateway?.mode === 'remote' || process.env.OPENCLAW_GATEWAY_URL?.trim()) {
      throw new Error('Research team workers require the local gateway without a client URL override.');
    }
  }
  return {
    async run(work, prompt, model) {
      assertLocalGateway();
      const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
      const slash = model?.indexOf('/') ?? -1;
      const response = await callGatewayFromCli('agent', { json: true, expectFinal: true, timeout: '240000' }, {
        message: prompt, sessionKey: work.sessionKey, idempotencyKey: work.id,
        deliver: false, timeout: 180, label: '科研群组',
        promptMode: 'minimal', bootstrapContextMode: 'lightweight',
        ...(model && slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1) } : {}),
      });
      if (response.status !== 'ok') throw new Error('执行未成功结束：' + String(response.status));
      const result = response.result as { payloads?: Array<{text?: string; isError?: boolean; isReasoning?: boolean}>; meta?: {finalAssistantVisibleText?: string; agentMeta?: {usage?: unknown}} } | undefined;
      const text = result?.payloads?.filter(p => !p.isError && !p.isReasoning).map(p => p.text ?? '').join('\n').trim() || result?.meta?.finalAssistantVisibleText || '';
      return { text, usage: result?.meta?.agentMeta?.usage };
    },
    async abort(work) {
      assertLocalGateway();
      const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
      const result = await callGatewayFromCli('chat.abort', {json: true, timeout: '10000'}, { sessionKey: work.sessionKey, runId: work.id });
      return result.aborted === true;
    },
  };
}
