import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToolStreamStore } from '../../stores/tool-stream';
import { useChatStore } from '../../stores/chat';
import { normalizeSessionKey } from '../../utils/session-key';
import { fmtTime, safeStringifyDetail } from '../../utils/activity-log';

interface ToolActivityHistoryProps {
  resetKey?: number;
}

export default function ToolActivityHistory({ resetKey = 0 }: ToolActivityHistoryProps) {
  const { t } = useTranslation();
  const activityLog = useToolStreamStore((s) => s.activityLog);
  const clearActivityLog = useToolStreamStore((s) => s.clearActivityLog);
  const sessionKey = useChatStore((s) => s.sessionKey);
  const [expanded, setExpanded] = useState(false);

  const entries = useMemo(
    () => activityLog
      .filter((e) => normalizeSessionKey(e.sessionKey) === normalizeSessionKey(sessionKey))
      .slice(-30)
      .reverse(),
    [activityLog, sessionKey],
  );

  // Switch session -> collapse by default; user has to explicitly open it.
  useEffect(() => {
    setExpanded(false);
  }, [sessionKey]);

  useEffect(() => {
    setExpanded(false);
  }, [resetKey]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        marginTop: 8,
        marginBottom: 16,
      }}
    >
      <div
        style={{
          width: '85%',
          border: '1px dashed var(--border, rgba(255, 255, 255, 0.18))',
          borderRadius: 12,
          background: 'var(--surface, rgba(255, 255, 255, 0.04))',
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 12,
          color: 'var(--text-secondary)',
          fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
          userSelect: 'none',
        }}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
            padding: 0,
          }}
        >
          {expanded ? '▾' : '▸'} {t('chat.activityHistory')}{entries.length > 0 ? ` (${entries.length})` : ''}
        </button>
        {entries.length > 0 && (
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              clearActivityLog();
            }}
            type="button"
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            {t('chat.clear')}
          </button>
        )}
      </div>

      {expanded && entries.length === 0 && (
        <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center' }}>
          {t('chat.noActivityYet', 'No activity yet')}
        </div>
      )}
      {expanded && entries.length > 0 && (
        <div
          style={{
            width: '85%',
            maxHeight: 180,
            overflow: 'auto',
            padding: '6px 10px',
            border: '1px dashed var(--border, rgba(255, 255, 255, 0.18))',
            borderTop: 'none',
            borderRadius: '0 0 12px 12px',
            background: 'var(--surface, rgba(255, 255, 255, 0.04))',
          }}
        >
          {entries.map((e) => (
            <details key={e.id} style={{ padding: '3px 0' }}>
              <summary
                style={{
                  display: 'flex',
                  gap: 8,
                  fontSize: 12,
                  fontFamily: "'Fira Code', 'JetBrains Mono', monospace",
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  listStyle: 'none',
                }}
              >
                <span style={{ color: 'var(--text-tertiary)', minWidth: 56 }}>{fmtTime(e.ts)}</span>
                <span style={{ color: e.scope === 'background' ? '#F59E0B' : 'var(--text-tertiary)', minWidth: 26 }}>
                  {e.scope === 'background' ? 'BG' : 'FG'}
                </span>
                <span>{e.text}</span>
                {typeof e.durationMs === 'number' && (
                  <span style={{ color: 'var(--text-tertiary)' }}>{Math.round(e.durationMs)}ms</span>
                )}
              </summary>
              <pre
                style={{
                  margin: '6px 0 0 64px',
                  padding: 8,
                  borderRadius: 6,
                  background: 'var(--code-bg, rgba(0,0,0,0.2))',
                  border: '1px solid var(--border)',
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: 'var(--text-secondary)',
                  overflowX: 'auto',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
{safeStringifyDetail({
  runId: e.runId,
  toolCallId: e.toolCallId,
  scope: e.scope,
  status: e.status,
  durationMs: e.durationMs,
  detail: e.detail,
})}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
