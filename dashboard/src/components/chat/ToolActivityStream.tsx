import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  selectPendingTools,
  useToolStreamStore,
  type PendingTool,
} from '../../stores/tool-stream';
import { LoadingOutlined, CheckCircleOutlined, ToolOutlined } from '@ant-design/icons';

function ToolItem({ tool }: { tool: PendingTool }) {
  const { t } = useTranslation();
  const isDone = tool.phase === 'result' || tool.phase === 'end';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 0',
        fontSize: 12,
        fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
        color: isDone ? 'var(--text-tertiary)' : 'var(--text-secondary)',
        transition: 'opacity 0.3s',
        opacity: tool.phase === 'end' ? 0.5 : 1,
      }}
    >
      {isDone ? (
        <CheckCircleOutlined style={{ color: '#22C55E', fontSize: 12 }} />
      ) : (
        <LoadingOutlined style={{ color: '#F59E0B', fontSize: 12 }} spin />
      )}
      <ToolOutlined style={{ fontSize: 11 }} />
      <span>{tool.name}</span>
      {!isDone && (
        <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
          {tool.phase === 'running' ? t('agent.toolRunning').toLowerCase() : '...'}
        </span>
      )}
    </div>
  );
}

export default function ToolActivityStream({ sessionKey }: { sessionKey: string }) {
  const pendingTools = useToolStreamStore(
    useShallow((state) => selectPendingTools(state, sessionKey)),
  );

  if (pendingTools.length === 0) return null;

  return (
    <div
      style={{
        padding: '4px 0 8px',
        borderLeft: '2px solid rgba(245, 158, 11, 0.3)',
        paddingLeft: 12,
        marginLeft: 4,
      }}
    >
      {pendingTools.map((tool) => (
        <ToolItem key={tool.toolCallId} tool={tool} />
      ))}
    </div>
  );
}
