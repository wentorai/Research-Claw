import { describe, expect, it } from 'vitest';
import {
  CRON_AUTH_FIRST,
  CRON_AUTH_NEW_EPISODE,
  CRON_AUTH_SECOND,
  CRON_PREFLIGHT_SKIP_FIRST,
  CRON_PREFLIGHT_SKIP_THIRD,
  CRON_SUCCESS_AFTER_FAILURE,
  CRON_TIMEOUT_FIRST,
  CRON_TIMEOUT_THIRD,
} from '../../__fixtures__/gateway-payloads/cron-events';
import {
  applyCronEpisodeEffect,
  classifyCronCompletion,
  type CronFailureEpisode,
} from '../../utils/cron-failure-notification';
import { navigateNotificationTarget } from '../../components/NotificationDropdown';
import { useUiStore } from '../../stores/ui';

/**
 * Drives the classifier the way CronEventListener does: decide, then apply the
 * write. `epoch` mirrors useGatewayStore.eventEpoch, which the listener reads
 * per event; the default of 0 keeps every unrelated case on one unbroken stream.
 */
function makeDashboard() {
  const episodes = new Map<string, CronFailureEpisode>();
  return {
    episodes,
    receive(payload: unknown, epoch = 0) {
      const decision = classifyCronCompletion(payload, { reportedEpisodes: episodes, epoch });
      applyCronEpisodeEffect(episodes, decision.episodeEffect);
      return decision;
    },
  };
}

describe('background cron failure policy — OpenClaw 2026.6.1 payload parity', () => {
  it('keeps the first transient timeout silent while OpenClaw can self-heal', () => {
    expect(classifyCronCompletion(CRON_TIMEOUT_FIRST)).toEqual({
      action: 'silent',
      reason: 'below-notify-threshold',
    });
  });

  it('rings once at the third consecutive transient failure', () => {
    const result = classifyCronCompletion(CRON_TIMEOUT_THIRD);
    expect(result).toMatchObject({
      action: 'notify-transient',
      failureKind: 'timeout',
      consecutiveCount: 3,
      targetSessionKey: CRON_TIMEOUT_THIRD.sessionKey,
    });
    if (result.action !== 'notify-transient') throw new Error('expected transient notification');
    expect(result.dedupKey).toContain(String(CRON_TIMEOUT_THIRD.runAtMs));
  });

  it('rings on the first configuration-permanent failure and routes to settings', () => {
    expect(classifyCronCompletion(CRON_AUTH_FIRST)).toMatchObject({
      action: 'notify-config',
      failureKind: 'auth',
      consecutiveCount: 1,
      targetPanel: 'settings',
    });
  });

  // The gateway drops cron broadcasts under back-pressure and the dashboard may
  // simply be closed, so a counter-based "only at 1" gate loses the report.
  it('still rings for a configuration failure first seen mid-episode', () => {
    const midEpisode = {
      ...CRON_AUTH_FIRST,
      job: {
        ...CRON_AUTH_FIRST.job,
        state: { ...CRON_AUTH_FIRST.job.state, consecutiveErrors: 7 },
      },
    };
    expect(classifyCronCompletion(midEpisode)).toMatchObject({
      action: 'notify-config',
      jobId: CRON_AUTH_FIRST.jobId,
      consecutiveCount: 7,
      targetPanel: 'settings',
    });
  });

  it('reports each configuration episode once, and re-arms after a success', () => {
    const dashboard = makeDashboard();
    expect(dashboard.receive(CRON_AUTH_FIRST)).toMatchObject({ action: 'notify-config' });
    // One run stays one data point however many times it is delivered.
    expect(dashboard.receive(CRON_AUTH_FIRST)).toEqual({
      action: 'silent',
      reason: 'duplicate-completion-event',
    });
    // The next run of the same episode: already reported, stay quiet.
    expect(dashboard.receive(CRON_AUTH_SECOND)).toMatchObject({
      action: 'silent',
      reason: 'episode-already-reported',
    });

    expect(dashboard.receive(CRON_SUCCESS_AFTER_FAILURE)).toMatchObject({ action: 'success' });
    expect(dashboard.episodes.size).toBe(0);

    expect(dashboard.receive(CRON_AUTH_NEW_EPISODE)).toMatchObject({ action: 'notify-config' });
  });

  /**
   * The defect this replaces: a per-job "already reported" flag cleared only on an
   * observed success. The gateway drops cron broadcasts under back-pressure, so
   * the success that ends an episode is exactly the event that can go missing —
   * and then every later episode of that job is silent forever.
   */
  it('re-reports a configuration failure when the recovery broadcast was lost', () => {
    const dashboard = makeDashboard();
    expect(dashboard.receive(CRON_AUTH_FIRST)).toMatchObject({
      action: 'notify-config',
      consecutiveCount: 1,
    });
    // CRON_SUCCESS_AFTER_FAILURE is deliberately NOT delivered here. OpenClaw
    // still zeroed its counter, which is why the next failure arrives at 1.
    const relapse = dashboard.receive(CRON_AUTH_NEW_EPISODE);
    expect(relapse).toMatchObject({ action: 'notify-config', consecutiveCount: 1 });
    if (relapse.action !== 'notify-config') throw new Error('expected config notification');
    // A distinct run, so a distinct notification rather than a suppressed duplicate.
    expect(relapse.dedupKey).not.toBe(
      `cron:failure:${CRON_AUTH_FIRST.jobId}:config:${CRON_AUTH_FIRST.runAtMs}`,
    );
  });

  /**
   * The residual hole after the counter-contiguity gate: when BOTH the recovery
   * success and the new episode's first run are lost, the first visible run of
   * the new episode is a 2 sitting exactly one above the reported watermark of
   * 1 — indistinguishable, on the counters alone, from the reported episode
   * continuing. The event-stream epoch is what breaks the tie: it changed, so
   * the run between the two events is unaccounted for and adjacency is not a
   * fact we hold.
   */
  it('re-reports at count 2 when the success and the new episode\'s first run were both lost', () => {
    const dashboard = makeDashboard();
    expect(dashboard.receive(CRON_AUTH_FIRST, 0)).toMatchObject({
      action: 'notify-config',
      consecutiveCount: 1,
    });
    // Same counter arithmetic as an in-episode sequel, different epoch.
    expect(dashboard.receive(CRON_AUTH_SECOND, 1)).toMatchObject({
      action: 'notify-config',
      consecutiveCount: 2,
    });
  });

  // The epoch reopens "is this still the episode I reported?", never "is this
  // run new?". A run's identity does not depend on what else reached us.
  it('keeps suppressing an exact redelivery of a reported run across an epoch change', () => {
    const dashboard = makeDashboard();
    expect(dashboard.receive(CRON_AUTH_FIRST, 0)).toMatchObject({ action: 'notify-config' });
    expect(dashboard.receive(CRON_AUTH_FIRST, 1)).toEqual({
      action: 'silent',
      reason: 'duplicate-completion-event',
    });
  });

  // Invalidation is scoped to the discontinuity, not sticky: once the stream is
  // whole again, the episode gate goes back to suppressing known news.
  it('re-engages the episode gate once the stream is continuous again', () => {
    const dashboard = makeDashboard();
    dashboard.receive(CRON_AUTH_FIRST, 0);
    expect(dashboard.receive(CRON_AUTH_SECOND, 1)).toMatchObject({ action: 'notify-config' });
    const third = {
      ...CRON_AUTH_SECOND,
      job: {
        ...CRON_AUTH_SECOND.job,
        state: { ...CRON_AUTH_SECOND.job.state, consecutiveErrors: 3 },
      },
      sessionId: 'session-auth-3',
      runAtMs: CRON_AUTH_SECOND.runAtMs + 21_600_000,
    };
    expect(dashboard.receive(third, 1)).toMatchObject({
      action: 'silent',
      reason: 'episode-already-reported',
    });
  });

  // An epoch change says "a run may be missing", not "this is now urgent". The
  // transient path still waits for OpenClaw's retries to prove they cannot heal.
  it('does not let an epoch change pull a transient failure under its threshold', () => {
    const dashboard = makeDashboard();
    const second = {
      ...CRON_TIMEOUT_FIRST,
      job: {
        ...CRON_TIMEOUT_FIRST.job,
        state: { ...CRON_TIMEOUT_FIRST.job.state, consecutiveErrors: 2 },
      },
      sessionId: 'session-timeout-2',
      runAtMs: CRON_TIMEOUT_FIRST.runAtMs + 21_600_000,
    };
    expect(dashboard.receive(second, 4)).toEqual({
      action: 'silent',
      reason: 'below-notify-threshold',
    });
  });

  /**
   * The same hazard on the transient path, which gated on the counter being
   * exactly 3: if that one broadcast is dropped, "greater than 3" then reads as
   * already-reported and the job goes quiet for the rest of the episode.
   */
  it('still reports a repeated transient failure when the threshold event was dropped', () => {
    const dashboard = makeDashboard();
    const fourth = {
      ...CRON_TIMEOUT_THIRD,
      job: {
        ...CRON_TIMEOUT_THIRD.job,
        state: { ...CRON_TIMEOUT_THIRD.job.state, consecutiveErrors: 4 },
      },
      runAtMs: CRON_TIMEOUT_THIRD.runAtMs + 21_600_000,
    };
    expect(dashboard.receive(fourth)).toMatchObject({
      action: 'notify-transient',
      consecutiveCount: 4,
    });
  });

  it('does not create a recovery notification for a successful run', () => {
    expect(classifyCronCompletion(CRON_SUCCESS_AFTER_FAILURE)).toMatchObject({
      action: 'success',
      jobId: 'monitor-job-7',
    });
  });

  // Error and skip counters reset each other in OpenClaw, so a change of failure
  // channel means the episode we reported is over even without a success.
  it('reports a skip episode that follows a reported error episode', () => {
    const dashboard = makeDashboard();
    expect(dashboard.receive(CRON_TIMEOUT_THIRD)).toMatchObject({ action: 'notify-transient' });
    expect(dashboard.receive(CRON_PREFLIGHT_SKIP_FIRST)).toMatchObject({
      action: 'silent',
      reason: 'below-notify-threshold',
    });
    expect(dashboard.receive(CRON_PREFLIGHT_SKIP_THIRD)).toMatchObject({ action: 'notify-skip' });
  });

  // A transient episode that escalates into a permanent misconfiguration is new
  // news: the fix changed from "wait" to "go edit your settings".
  it('reports a configuration failure that appears inside a reported transient episode', () => {
    const dashboard = makeDashboard();
    expect(dashboard.receive(CRON_TIMEOUT_THIRD)).toMatchObject({ action: 'notify-transient' });
    const escalated = {
      ...CRON_AUTH_FIRST,
      job: {
        ...CRON_AUTH_FIRST.job,
        state: { ...CRON_AUTH_FIRST.job.state, consecutiveErrors: 4 },
      },
    };
    expect(dashboard.receive(escalated)).toMatchObject({
      action: 'notify-config',
      targetPanel: 'settings',
    });
  });

  // A preflight skip returns before the run session is persisted, so the skip
  // notification must not offer to open it, and must not claim the job "failed".
  it('reports repeated provider-preflight skips as skips, routed to settings', () => {
    expect(classifyCronCompletion(CRON_PREFLIGHT_SKIP_FIRST)).toEqual({
      action: 'silent',
      reason: 'below-notify-threshold',
    });
    const third = classifyCronCompletion(CRON_PREFLIGHT_SKIP_THIRD);
    expect(third).toMatchObject({
      action: 'notify-skip',
      consecutiveCount: 3,
      targetPanel: 'settings',
    });
    if (third.action !== 'notify-skip') throw new Error('expected skip notification');
    expect(third.targetSessionKey).toBeUndefined();
    expect(third.dedupKey).toContain(':skipped:');
  });

  it('uses the post-run job snapshot counter, not a dashboard-local counter', () => {
    const malformed = {
      ...CRON_TIMEOUT_THIRD,
      job: {
        ...CRON_TIMEOUT_THIRD.job,
        state: {
          ...CRON_TIMEOUT_THIRD.job.state,
          consecutiveErrors: undefined,
        },
      },
    };
    expect(classifyCronCompletion(malformed)).toEqual({
      action: 'silent',
      reason: 'missing-consecutive-count',
    });
  });

  it('opens Settings from a persisted configuration-failure notification', () => {
    useUiStore.setState({ rightPanelTab: 'library', rightPanelOpen: false });
    navigateNotificationTarget({ targetPanel: 'settings' });
    expect(useUiStore.getState()).toMatchObject({
      rightPanelTab: 'settings',
      rightPanelOpen: true,
    });
  });
});
