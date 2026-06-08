import { useGatewayStore } from '../stores/gateway';

/** Push dashboard local system-prompt append to the gateway plugin (in-memory). */
export async function syncSystemPromptAppendToGateway(text: string): Promise<void> {
  const client = useGatewayStore.getState().client;
  if (!client?.isConnected) return;
  try {
    await client.request('rc.dashboard.setSystemPromptAppend', { text: text.trim() });
  } catch (err) {
    console.warn('[config] syncSystemPromptAppend failed:', err);
  }
}
