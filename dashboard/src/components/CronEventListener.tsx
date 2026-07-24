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
import { classifyCronCompletion } from '../utils/cron-failure-notification';

export default function CronEventListener() {
  const { notification } = App.useApp();
  const { t } = useTranslation();
  const client = useGatewayStore((s) => s.client);

  useEffect(() => {
    if (!client) return;

    // Gateway broadcasts "cron" events globally, not filtered by session.
    // OpenClaw 2026.6.1 includes a post-run job snapshot; RC stores remain the
    // preferred source for the user-facing preset/monitor name.
    const unsub = client.subscribe('cron', (payload) => {
      const evt = payload as {
        action?: string;
        jobId?: string;
        status?: string;
        error?: string;
        summary?: string;
        sessionKey?: string;
        job?: {
          name?: string;
          state?: {
            consecutiveErrors?: number;
            lastError?: string;
            lastErrorReason?: string;
          };
        };
      };
      if (evt.action !== 'finished' || !evt.jobId) return;

      // Resolve display name by matching gateway_job_id
      const cronPreset = useCronStore.getState().presets.find((p) => p.gateway_job_id === evt.jobId);
      const monitor = useMonitorStore.getState().monitors.find((m) => m.gateway_job_id === evt.jobId);
      const jobName = cronPreset?.name ?? monitor?.name ?? evt.job?.name ?? t('cron.taskCompleted');
      const decision = classifyCronCompletion(payload);

      if (decision.action === 'silent') return;

      if (decision.action !== 'success') {
        const configFailure = decision.action === 'notify-config';
        const title = configFailure
          ? t('cron.configFailureTitle', { name: jobName })
          : t('cron.transientFailureTitle', {
              name: jobName,
              count: decision.consecutiveCount,
            });
        const body = configFailure
          ? t('cron.configFailureBody', { error: decision.rawError })
          : t('cron.transientFailureBody', { error: decision.rawError });
        const toastKey = decision.dedupKey;
        const targetSessionKey = decision.targetSessionKey
          ? normalizeSessionKey(decision.targetSessionKey)
          : undefined;

        notification.error({
          key: toastKey,
          message: title,
          description: body,
          duration: 0,
          placement: 'topRight',
          btn: configFailure ? (
            <Button
              type="link"
              size="small"
              onClick={() => {
                useUiStore.getState().setRightPanelTab('settings');
                notification.destroy(toastKey);
              }}
            >
              {t('cron.openSettings')}
            </Button>
          ) : targetSessionKey ? (
            <Button
              type="link"
              size="small"
              onClick={() => {
                useUiStore.getState().setCronSessionsFolded(false);
                useSessionsStore.getState().switchSession(targetSessionKey);
                notification.destroy(toastKey);
              }}
            >
              {t('cron.viewFailure')}
            </Button>
          ) : undefined,
        });

        useUiStore.getState().addNotification({
          type: 'error',
          title,
          body,
          dedupKey: toastKey,
          targetSessionKey,
          targetPanel: decision.targetPanel,
        });
        return;
      }

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
