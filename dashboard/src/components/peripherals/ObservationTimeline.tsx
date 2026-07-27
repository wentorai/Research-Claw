/**
 * ObservationTimeline — vertical timeline of periph observations for a device.
 *
 * Consumed by CameraDetail at data-testid="periph-camera-timeline" (T16).
 *
 * Data: usePeripheralsStore.observations[deviceId] (loaded on mount, paginated via before cursor).
 * Image fetch: GET /rc/download?path=<frame_path> with Bearer token (same as DockerFileModal.tsx).
 * Verdict colors: ok=green, alert=red, missed/error=grey, unverified=amber, info=blue.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Spin, Timeline, Typography } from 'antd';
import {
  CheckCircleFilled,
  ClockCircleFilled,
  ExclamationCircleFilled,
  InfoCircleFilled,
  MinusCircleFilled,
  QuestionCircleFilled,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { usePeripheralsStore, type PeriphVerdict, type PeriphObservationRow } from '../../stores/peripherals';
import { relativeTime } from '../../utils/relativeTime';

const { Text } = Typography;

// ── Verdict display ───────────────────────────────────────────────────────────

const VERDICT_COLOR: Record<PeriphVerdict, string> = {
  ok: '#22C55E',          // green
  alert: '#EF4444',       // red
  missed: '#9CA3AF',      // grey
  error: '#9CA3AF',       // grey
  unverified: '#F59E0B',  // amber
  info: '#3B82F6',        // blue
};

function VerdictIcon({ verdict }: { verdict: PeriphVerdict }) {
  const color = VERDICT_COLOR[verdict] ?? '#9CA3AF';
  const style = { color, fontSize: 14 };

  switch (verdict) {
    case 'ok':         return <CheckCircleFilled style={style} />;
    case 'alert':      return <ExclamationCircleFilled style={style} />;
    case 'unverified': return <QuestionCircleFilled style={style} />;
    case 'info':       return <InfoCircleFilled style={style} />;
    case 'missed':
    case 'error':
    default:           return <MinusCircleFilled style={style} />;
  }
}

// ── Gateway HTTP base (mirrors DockerFileModal.tsx:24-28) ────────────────────

function getGatewayHttpUrl(): string {
  const loc = window.location;
  if (loc.port === '5175') return 'http://127.0.0.1:28789';
  return loc.origin;
}

function buildFrameUrl(path: string): string {
  return `${getGatewayHttpUrl()}/rc/download?path=${encodeURIComponent(path)}`;
}

// ── Authenticated thumbnail (fetch + Bearer + blob URL) ───────────────────────

interface FrameThumbnailProps {
  framePath: string;
}

function FrameThumbnail({ framePath }: FrameThumbnailProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Track the latest objectUrl created so we can revoke it on unmount / re-fetch
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const token = new URLSearchParams(window.location.search).get('token') || 'research-claw';
        const res = await fetch(buildFrameUrl(framePath), {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setObjectUrl(url);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, [framePath]);

  if (failed) {
    // Grey placeholder — non-fatal; keeps the row intact
    return (
      <div
        data-testid="periph-timeline-frame"
        style={{
          width: 120,
          height: 80,
          borderRadius: 4,
          background: '#374151',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <MinusCircleFilled style={{ color: '#6B7280', fontSize: 20 }} />
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        data-testid="periph-timeline-frame"
        style={{
          width: 120,
          height: 80,
          borderRadius: 4,
          background: '#1F2937',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Spin size="small" />
      </div>
    );
  }

  return (
    // eslint-disable-next-line jsx-a11y/img-redundant-alt
    <img
      data-testid="periph-timeline-frame"
      src={objectUrl}
      width={120}
      height={80}
      style={{ objectFit: 'cover', borderRadius: 4, display: 'block' }}
      alt="frame"
    />
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ObservationTimelineProps {
  deviceId: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

// Stable empty array to avoid new reference on every render when deviceId has no observations.
const EMPTY_OBS: PeriphObservationRow[] = [];

export default function ObservationTimeline({ deviceId }: ObservationTimelineProps) {
  const { t, i18n } = useTranslation();
  const observationsMap = usePeripheralsStore((s) => s.observations);
  const observations = observationsMap[deviceId] ?? EMPTY_OBS;
  const loadObservations = usePeripheralsStore((s) => s.loadObservations);
  // Subscribe to the per-device pager flag so the "load earlier" button appears
  // only when the last page came back full (older rows may remain). Reading the
  // map (not calling the selector) keeps this reactive to store updates.
  const hasMore = usePeripheralsStore((s) => s.observationsHasMore[deviceId] === true);
  const [initialLoading, setInitialLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Initial load on mount
  useEffect(() => {
    setInitialLoading(true);
    void loadObservations(deviceId).finally(() => setInitialLoading(false));
  }, [deviceId, loadObservations]);

  // Oldest row = keyset cursor for "load earlier". Both parts are required:
  // captured_at (second precision) + rowid cursor to tiebreak same-second rows.
  const oldest = useMemo(() => {
    if (observations.length === 0) return null;
    return observations[observations.length - 1];
  }, [observations]);

  const handleLoadMore = async () => {
    if (!oldest) return;
    setLoadingMore(true);
    try {
      await loadObservations(deviceId, { before: oldest.captured_at, before_cursor: oldest.cursor });
    } finally {
      setLoadingMore(false);
    }
  };

  if (initialLoading) {
    return (
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <Spin size="small" />
      </div>
    );
  }

  if (observations.length === 0) {
    return (
      <div
        data-testid="periph-timeline-empty"
        style={{ padding: '12px 0', textAlign: 'center' }}
      >
        <ClockCircleFilled style={{ fontSize: 20, color: '#6B7280', display: 'block', marginBottom: 6 }} />
        <Text style={{ color: '#6B7280', fontSize: 13 }}>
          {t('periph.timeline.empty', 'No observations yet.')}
        </Text>
        <br />
        <Text style={{ color: '#6B7280', fontSize: 12 }}>
          {t('periph.timeline.emptyHint', 'Observations will appear here after the first scheduled check runs.')}
        </Text>
      </div>
    );
  }

  const items = observations.map((obs) => ({
    key: obs.id,
    dot: <VerdictIcon verdict={obs.verdict} />,
    children: (
      <div
        data-testid={`periph-timeline-obs-${obs.id}`}
        style={{ paddingBottom: 8 }}
        // P1-N1: explain why a check was missed — browser-camera frames can only be
        // captured while the Dashboard is open and the host is awake (D9 boundary).
        title={obs.verdict === 'missed'
          ? t(
              'periph.timeline.missedHover',
              'No frame captured: the Dashboard was offline or this machine was asleep when this check ran.',
            )
          : undefined}
      >
        {/* Frame thumbnail (if available) — fetched with Bearer auth to avoid 401 */}
        {obs.frame_path && (
          <div style={{ marginBottom: 6 }}>
            <FrameThumbnail framePath={obs.frame_path} />
          </div>
        )}
        {/* Summary */}
        <Text style={{ fontSize: 13, display: 'block' }}>{obs.summary}</Text>
        {/* Relative time */}
        <Text style={{ fontSize: 11, color: '#9CA3AF' }}>
          {relativeTime(obs.captured_at, i18n.language)}
        </Text>
      </div>
    ),
  }));

  return (
    <div data-testid="periph-timeline-root">
      <Timeline items={items} style={{ paddingTop: 8 }} />

      {hasMore && (
        <Button
          data-testid="periph-timeline-load-more"
          type="text"
          size="small"
          loading={loadingMore}
          onClick={() => { void handleLoadMore(); }}
          style={{ display: 'block', margin: '0 auto' }}
        >
          {t('periph.timeline.loadMore', 'Load earlier')}
        </Button>
      )}
    </div>
  );
}
