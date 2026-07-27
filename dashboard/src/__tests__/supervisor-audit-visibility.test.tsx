/**
 * Every supervision event the plugin records must be legible in the audit panel.
 *
 * `LOG_TYPE_META` is the panel's whole vocabulary: it supplies the group label, the
 * icon/colour, AND the entries of the type filter. A category missing from it is
 * rendered under "Unknown" and cannot be filtered for — so a human approval, a
 * citation check or a "deep review is down" warning all collapse into the same
 * anonymous bucket. That is the audit-trail version of a silent no-op: the plugin
 * did the work and the UI refuses to name it.
 *
 * The list is therefore checked against the plugin's own `AuditLogType` union
 * rather than a copy maintained here, so adding a category to the plugin without
 * teaching the Dashboard about it fails the build.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (opts && typeof opts === 'object' && 'reason' in opts) return `${key}:${String(opts.reason)}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import SupervisorPanel, { LOG_TYPE_META } from '../components/panels/SupervisorPanel';
import { useGatewayStore } from '../stores/gateway';
import { useConfigStore } from '../stores/config';
import { useSupervisorStore } from '../stores/supervisor';
import en from '../i18n/en.json';
import zh from '../i18n/zh-CN.json';

type Bundle = Record<string, Record<string, string>>;
const LOCALES = [
  ['en', en as unknown as Bundle],
  ['zh-CN', zh as unknown as Bundle],
] as const;

/**
 * The plugin's `AuditLogType` union — the single source of truth for categories.
 *
 * Comments are stripped BEFORE the union is located: every member of the union
 * carries a trailing `//` comment, and a single semicolon inside one of them
 * (`// Review of tool calls; e.g. exec/write`) would otherwise end the non-greedy
 * match on the first line. That failure mode is silent and inverted — the parse
 * returns one category, every category the panel does know about is "covered",
 * and a genuinely unhandled new category passes. The floor assertion below is the
 * backstop: an empty or truncated parse must fail loudly, not vacuously pass.
 */
function pluginAuditTypes(): string[] {
  // vitest runs with cwd = the dashboard package root (where vitest.config.ts lives).
  const raw = readFileSync(resolve(process.cwd(), '../extensions/dual-model-supervisor/src/core/types.ts'), 'utf-8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const union = src.match(/export type AuditLogType =([\s\S]*?);/);
  if (!union) throw new Error('AuditLogType union not found in the plugin sources');
  const types = [...union[1].matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
  // A truncated parse is indistinguishable from full coverage, so refuse to run on one.
  if (types.length < 5) {
    throw new Error(`AuditLogType parsed as only [${types.join(', ')}] — the union parse is broken, not the UI`);
  }
  return types;
}

/** Mount the panel behind a gateway that answers with the given status + audit rows. */
function mountPanel(opts: { status?: Record<string, unknown>; entries?: Record<string, unknown>[] } = {}) {
  const entries = opts.entries ?? [];
  const request = vi.fn().mockImplementation((method: string) => {
    if (method === 'rc.supervisor.status') return Promise.resolve(opts.status ?? {});
    if (method === 'rc.supervisor.log') return Promise.resolve({ entries, total: entries.length });
    return Promise.resolve({});
  });
  useGatewayStore.setState({
    client: { isConnected: true, request, connect: vi.fn(), disconnect: vi.fn() } as unknown as ReturnType<
      typeof useGatewayStore.getState
    >['client'],
    state: 'connected',
  });
  return render(<SupervisorPanel />);
}

/** Supervision on, inheriting the main model — the default path since C12. */
function inheritedStatus(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    reviewMode: 'correct',
    supervisorModel: '', // the inherit marker — never a model name
    modelSource: 'inherited',
    effectiveSupervisorModel: 'custom/test-model',
    reviewerReady: true,
    courseCorrectionEnabled: true,
    deviationThreshold: 0.5,
    forceRegenerate: false,
    maxRegenerateAttempts: 3,
    highRiskTools: [],
    stats: { total: 0, blocked: 0, corrected: 0, warnings: 0 },
    activeSessions: 0,
    sessionsInfo: [],
    ...overrides,
  };
}

beforeEach(() => {
  useGatewayStore.setState({ client: null, state: 'disconnected' });
  useConfigStore.setState({ theme: 'dark', locale: 'en' });
  useSupervisorStore.getState().stopPolling();
  useSupervisorStore.setState({ status: null, config: null, auditLog: [], auditLogTotal: 0, pollingTimer: null });
});

afterEach(() => {
  useSupervisorStore.getState().stopPolling();
  cleanup();
  vi.restoreAllMocks();
});

describe('the audit panel can name every event the plugin records', () => {
  it('has a label for each AuditLogType the plugin can emit', () => {
    const missing = pluginAuditTypes().filter((t) => !(t in LOG_TYPE_META));
    expect(missing, `audit types with no Dashboard entry: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(LOCALES)('%s translates every audit-type label', (_locale, bundle) => {
    for (const [type, meta] of Object.entries(LOG_TYPE_META)) {
      const [ns, key] = meta.labelKey.split('.');
      expect(bundle[ns]?.[key], `${meta.labelKey} (type ${type}) is untranslated`).toBeTypeOf('string');
    }
  });

  it('renders a reviewer-health warning under its own heading, not "Unknown"', async () => {
    mountPanel({
      status: inheritedStatus(),
      entries: [
        {
          id: 1,
          sessionId: 'supervisor',
          type: 'reviewer_health',
          action: 'warn',
          details: 'Deep review unavailable (no reviewer model configured).',
          timestamp: 1_700_000_000_000,
        },
      ],
    });

    await waitFor(() => expect(screen.getByText('supervisor.typeReviewerHealth')).toBeInTheDocument());
    expect(screen.queryByText('supervisor.typeUnknown')).toBeNull();
  });
});

describe('the audit panel reports which model is actually reviewing', () => {
  it('shows the inherited model instead of a blank slot', async () => {
    mountPanel({ status: inheritedStatus() });

    await waitFor(() => expect(screen.getByText('custom/test-model')).toBeInTheDocument());
  });

  it('states that deep review is down — and that the deterministic gate is not', async () => {
    mountPanel({
      status: inheritedStatus({
        modelSource: 'unavailable',
        effectiveSupervisorModel: '',
        reviewerReady: false,
        reviewerUnavailableReason: 'no reviewer model configured',
      }),
    });

    await waitFor(() =>
      expect(screen.getByText('supervisor.reviewerUnavailable:no reviewer model configured')).toBeInTheDocument(),
    );
  });
});
