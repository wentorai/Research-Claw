/**
 * Layer 2 (#33): Listen to gateway "cron" events and show themed toast notifications.
 *
 * Must be rendered INSIDE <AntdApp> so App.useApp().notification inherits
 * the ConfigProvider theme (dark mode, brand colors, etc.).
 *
 * Renders nothing — purely a side-effect component.
 */

import { useEffect } from 'react';
import { App, Button } from 'antd';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { useGatewayStore } from '../stores/gateway';
import { useSessionsStore } from '../stores/sessions';
import { useUiStore } from '../stores/ui';
import { useCronStore } from '../stores/cron';
import { useMonitorStore } from '../stores/monitor';
import { normalizeSessionKey } from '../utils/session-key';

export default function CronEventListener() {
  const { notification } = App.useApp();
  const { t } = useTranslation();
  const client = useGatewayStore((s) => s.client);

  useEffect(() => {
    if (!client) return;

    // Gateway broadcasts "cron" events globally (server-cron.ts:359), not filtered by session.
    // CronEvent payload contains jobId, action, summary, sessionKey but NOT the job name —
    // we resolve the name from useCronStore/useMonitorStore via gateway_job_id.
    const unsub = client.subscribe('cron', (payload) => {
      const evt = payload as {
        action?: string;
        jobId?: string;
        summary?: string;
        sessionKey?: string;
      };
      if (evt.action !== 'finished' || !evt.jobId) return;

      // Resolve display name by matching gateway_job_id
      const cronPreset = useCronStore.getState().presets.find((p) => p.gateway_job_id === evt.jobId);
      const monitor = useMonitorStore.getState().monitors.find((m) => m.gateway_job_id === evt.jobId);
      const jobName = cronPreset?.name ?? monitor?.name ?? t('cron.taskCompleted');

      // Resolve target session key for click-to-navigate
      const targetSessionKey = evt.sessionKey ? normalizeSessionKey(evt.sessionKey) : undefined;

      // Themed toast notification (inherits dark theme from AntdApp context)
      const toastKey = `cron:finished:${evt.jobId}`;
      notification.info({
        key: toastKey,
        message: jobName,
        description: evt.summary ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <span style={{ display: 'block', margin: 0 }}>{children}</span>,
              ul: ({ children }) => <ul style={{ margin: '2px 0', paddingLeft: 16 }}>{children}</ul>,
              ol: ({ children }) => <ol style={{ margin: '2px 0', paddingLeft: 16 }}>{children}</ol>,
              li: ({ children }) => <li style={{ margin: 0 }}>{children}</li>,
              code: ({ children }) => (
                <code style={{ background: 'rgba(255,255,255,0.08)', padding: '1px 3px', borderRadius: 2, fontSize: '0.9em' }}>
                  {children}
                </code>
              ),
              pre: ({ children }) => <>{children}</>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-secondary, #3B82F6)' }}>
                  {children}
                </a>
              ),
            }}
          >
            {evt.summary.slice(0, 200)}
          </ReactMarkdown>
        ) : undefined,
        duration: 5,
        placement: 'topRight',
        btn: targetSessionKey ? (
          <Button
            type="link"
            size="small"
            onClick={() => {
              useUiStore.getState().setCronSessionsFolded(false);
              useSessionsStore.getState().switchSession(targetSessionKey);
              notification.destroy(toastKey);
            }}
          >
            {t('cron.viewResult')}
          </Button>
        ) : undefined,
      });

      // Persist to bell notification panel
      useUiStore.getState().addNotification({
        type: 'system',
        title: jobName,
        body: evt.summary?.slice(0, 200),
        dedupKey: toastKey,
        targetSessionKey,
      });
    });

    return unsub;
  }, [client, notification, t]);

  return null;
}
