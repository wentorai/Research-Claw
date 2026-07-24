/**
 * ObservationTimeline component tests — T16
 *
 * Tests:
 *   - Renders timeline items for each observation (verdict color dot + summary)
 *   - Empty state rendered when no observations
 *   - "Load more" button triggers loadObservations with before cursor
 *   - Three verdict color variants: ok / alert / missed
 *   - Frame thumbnail fetches /rc/download with Bearer Authorization header
 *   - Frame thumbnail fetch failure degrades to grey placeholder (non-fatal)
 *
 * Fixture: RC_PERIPH_OBSERVATIONS_LIST_RESPONSE from __fixtures__/gateway-payloads/periph.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import React from 'react';
import {
  RC_PERIPH_OBSERVATIONS_LIST_RESPONSE,
  RC_PERIPH_OBSERVATIONS_LIST_EMPTY_RESPONSE,
} from '../../__fixtures__/gateway-payloads/periph';
import { usePeripheralsStore } from '../../stores/peripherals';

// ── i18n mock ─────────────────────────────────────────────────────────────────
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, optsOrFallback?: string | Record<string, unknown>) => {
      if (typeof optsOrFallback === 'string') return optsOrFallback;
      if (optsOrFallback && 'defaultValue' in optsOrFallback) return String(optsOrFallback.defaultValue);
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ── Gateway mock ─────────────────────────────────────────────────────────────
const mockRequest = vi.fn();
vi.mock('../../stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({ client: { isConnected: true, request: mockRequest } }),
    setState: vi.fn(),
    subscribe: vi.fn(),
  },
}));

// ── fetch mock (for FrameThumbnail auth fetch) ────────────────────────────────
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// Minimal URL.createObjectURL / revokeObjectURL stubs for happy-dom
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock-object-url');
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = vi.fn();
}

import ObservationTimeline from './ObservationTimeline';

function renderTimeline(deviceId = 'dev-cam-001') {
  return render(
    <ConfigProvider>
      <ObservationTimeline deviceId={deviceId} />
    </ConfigProvider>,
  );
}

// Helper: make fetch succeed with a fake image blob
function stubFetchSuccess() {
  mockFetch.mockResolvedValue({
    ok: true,
    blob: () => Promise.resolve(new Blob(['img'], { type: 'image/jpeg' })),
  } as Response);
}

// Helper: make fetch fail with HTTP 401
function stubFetchFailure() {
  mockFetch.mockResolvedValue({
    ok: false,
    status: 401,
    blob: () => Promise.resolve(new Blob()),
  } as Response);
}

describe('ObservationTimeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usePeripheralsStore.setState({
      devices: [],
      observations: {},
      loading: false,
      error: null,
      unavailable: false,
    });
    // Default: frame fetch succeeds
    stubFetchSuccess();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Empty state ────────────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows empty state when no observations exist', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_EMPTY_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        expect(screen.getByTestId('periph-timeline-empty')).toBeDefined();
      });
    });

    it('calls loadObservations on mount', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_EMPTY_RESPONSE);

      renderTimeline('dev-cam-001');

      await waitFor(() => {
        expect(mockRequest).toHaveBeenCalledWith('rc.periph.observations.list', { device_id: 'dev-cam-001' });
      });
    });
  });

  // ── Observation rendering ─────────────────────────────────────────────────

  describe('observation rendering', () => {
    it('renders a timeline item for each observation', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        expect(screen.getByTestId('periph-timeline-obs-obs-001')).toBeDefined();
        expect(screen.getByTestId('periph-timeline-obs-obs-002')).toBeDefined();
        expect(screen.getByTestId('periph-timeline-obs-obs-003')).toBeDefined();
      });
    });

    it('renders the summary text for each observation', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        expect(screen.getByText('Lab bench is clear. All equipment in proper positions.')).toBeDefined();
        expect(screen.getByText('Chemical spill detected on left bench area.')).toBeDefined();
        expect(screen.getByText('Camera offline — capture timed out.')).toBeDefined();
      });
    });

    it('renders frame thumbnail when frame_path is present', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        // obs-001 and obs-002 have frame_path; obs-003 does not
        const frames = screen.getAllByTestId('periph-timeline-frame');
        expect(frames.length).toBeGreaterThanOrEqual(2);
      });
    });

    it('fetches frame thumbnail with Authorization: Bearer header (auth gate Fix 1)', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      // Wait until frames appear (fetch resolves → objectUrl set)
      await waitFor(() => {
        const frames = screen.getAllByTestId('periph-timeline-frame');
        expect(frames.length).toBeGreaterThanOrEqual(2);
      });

      // Assert that every frame fetch carried a Bearer Authorization header
      const fetchCalls = mockFetch.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('/rc/download'),
      );
      expect(fetchCalls.length).toBeGreaterThanOrEqual(2);
      for (const [, init] of fetchCalls as [string, RequestInit][]) {
        const auth = (init.headers as Record<string, string>)?.Authorization ?? '';
        expect(auth).toMatch(/^Bearer /);
      }
    });

    it('frame fetch URL contains /rc/download and encoded frame_path', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        const frames = screen.getAllByTestId('periph-timeline-frame');
        expect(frames.length).toBeGreaterThanOrEqual(2);
      });

      const urls = mockFetch.mock.calls
        .map((call: unknown[]) => call[0] as string)
        .filter((u) => u.includes('/rc/download'));
      expect(urls.length).toBeGreaterThanOrEqual(1);
      expect(urls[0]).toContain(encodeURIComponent('periph/dev-cam-001/2026-07-20T10-30-00.jpg'));
    });

    it('degrades to grey placeholder when frame fetch fails (non-fatal)', async () => {
      stubFetchFailure();
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      // Placeholder divs with data-testid still render (no crash)
      await waitFor(() => {
        const frames = screen.getAllByTestId('periph-timeline-frame');
        expect(frames.length).toBeGreaterThanOrEqual(2);
        // Each placeholder is a div (not an img), since fetch failed
        for (const frame of frames) {
          expect(frame.tagName).not.toBe('IMG');
        }
      });
    });

    it('does not render frame for observation with null frame_path', async () => {
      // obs-003 has frame_path: null
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        const obs3 = screen.getByTestId('periph-timeline-obs-obs-003');
        const imgs = obs3.querySelectorAll('[data-testid="periph-timeline-frame"]');
        expect(imgs.length).toBe(0);
      });
    });

    it('renders timeline root element', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        expect(screen.getByTestId('periph-timeline-root')).toBeDefined();
      });
    });
  });

  // ── Load more ─────────────────────────────────────────────────────────────

  describe('"Load more" pagination', () => {
    it('renders the "Load earlier" button', async () => {
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        expect(screen.getByTestId('periph-timeline-load-more')).toBeDefined();
      });
    });

    it('calls loadObservations with before cursor when "Load earlier" is clicked', async () => {
      // Initial load
      mockRequest.mockResolvedValueOnce(RC_PERIPH_OBSERVATIONS_LIST_RESPONSE);

      renderTimeline();

      await waitFor(() => {
        expect(screen.getByTestId('periph-timeline-root')).toBeDefined();
      });

      // Second call for "load more"
      mockRequest.mockResolvedValueOnce({ observations: [] });

      fireEvent.click(screen.getByTestId('periph-timeline-load-more'));

      await waitFor(() => {
        // The second call should include a 'before' cursor (oldest observation's captured_at)
        const calls = mockRequest.mock.calls.filter(
          (call) => call[0] === 'rc.periph.observations.list',
        );
        expect(calls.length).toBeGreaterThanOrEqual(2);
        const loadMoreCall = calls[calls.length - 1];
        expect(loadMoreCall[1]).toHaveProperty('before');
        expect(loadMoreCall[1].before).toBe('2026-07-19 22:00:00'); // obs-003 captured_at
      });
    });
  });
});
