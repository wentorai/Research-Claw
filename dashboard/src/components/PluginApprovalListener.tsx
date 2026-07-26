import { useEffect } from 'react';
import ApprovalCard from './chat/cards/ApprovalCard';
import { useApprovalsStore, type PluginApprovalRequest } from '../stores/approvals';
import { useGatewayStore } from '../stores/gateway';

function isPluginApprovalRequest(value: unknown): value is PluginApprovalRequest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PluginApprovalRequest>;
  return typeof candidate.id === 'string'
    && candidate.id.startsWith('plugin:')
    && !!candidate.request
    && typeof candidate.request.title === 'string'
    && typeof candidate.createdAtMs === 'number'
    && typeof candidate.expiresAtMs === 'number';
}

function riskLevel(severity: PluginApprovalRequest['request']['severity']): 'low' | 'medium' | 'high' {
  if (severity === 'critical') return 'high';
  if (severity === 'warning') return 'medium';
  return 'low';
}

export default function PluginApprovalListener() {
  const client = useGatewayStore((state) => state.client);
  const pending = useApprovalsStore((state) => state.pending);
  const add = useApprovalsStore((state) => state.add);
  const remove = useApprovalsStore((state) => state.remove);

  useEffect(() => {
    if (!client) return;
    const unsubscribeRequested = client.subscribe('plugin.approval.requested', (payload) => {
      if (isPluginApprovalRequest(payload)) add(payload);
    });
    const unsubscribeResolved = client.subscribe('plugin.approval.resolved', (payload) => {
      const id = payload && typeof payload === 'object'
        ? (payload as { id?: unknown }).id
        : undefined;
      if (typeof id === 'string') remove(id);
    });
    return () => {
      unsubscribeRequested();
      unsubscribeResolved();
    };
  }, [add, client, remove]);

  if (pending.length === 0) return null;

  return (
    <div
      aria-live="assertive"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 40,
        width: 'min(440px, calc(100vw - 48px))',
        maxHeight: 'calc(100vh - 80px)',
        overflowY: 'auto',
        zIndex: 1300,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {pending.map((approval) => (
        <ApprovalCard
          key={approval.id}
          type="approval_card"
          action={approval.request.title}
          context={approval.request.description ?? ''}
          risk_level={riskLevel(approval.request.severity)}
          details={{
            ...(approval.request.pluginId ? { plugin: approval.request.pluginId } : {}),
            ...(approval.request.toolName ? { tool: approval.request.toolName } : {}),
          }}
          approval_id={approval.id}
        />
      ))}
    </div>
  );
}
