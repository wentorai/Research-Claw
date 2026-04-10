/**
 * OAuth Auto-Save Tests
 *
 * Verifies the "close = save" UX after OAuth authentication success:
 *   1. OAuthModal calls onSuccess (auto-save) after rc.oauth.complete succeeds
 *   2. Shows saving spinner during auto-save
 *   3. Auto-closes on successful save
 *   4. Shows error + manual close when save fails
 *   5. Without onSuccess, retains original manual-close behavior
 *   6. Blocks modal close while auto-save is in progress
 *
 * References:
 *   - OAuthModal.tsx — auto-save flow in handleComplete
 *   - SettingsPanel.tsx — performSave extracted from handleSave
 *   - SetupWizard.tsx — performStart extracted from handleStart
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

// --- Mock i18n ---
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// --- Imports (after mocks) ---
import OAuthModal from '../components/OAuthModal';
import { useGatewayStore } from '../stores/gateway';

// --- Helpers ---

function createMockClient(requestFn?: (...args: unknown[]) => Promise<unknown>) {
  return {
    isConnected: true,
    request: requestFn ?? vi.fn().mockResolvedValue({}),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as ReturnType<typeof useGatewayStore.getState>['client'];
}

/** Simulate the 3-step OAuth flow up to the "Confirm Login" click. */
async function completeOAuthFlow(
  callbackUrl = 'http://localhost:1455/auth/callback?code=test_code&state=test_state',
) {
  // Step 0 → Step 1: afterOpenChange doesn't fire in happy-dom (no CSS animations),
  // so we click the "Start Auth" button visible in step 0.
  const startBtn = await waitFor(() => screen.getByText('oauth.startAuth'));
  fireEvent.click(startBtn);

  // Wait for step 1 to render (the "Paste URL" step).
  await waitFor(() => {
    expect(screen.getByText('oauth.step2Title')).toBeTruthy();
  });

  // Fill in the callback URL
  const textarea = screen.getByPlaceholderText('http://localhost:1455/auth/callback?code=...&state=...');
  fireEvent.change(textarea, { target: { value: callbackUrl } });

  // Click "Confirm Login"
  const confirmBtn = screen.getByText('oauth.confirmLogin');
  fireEvent.click(confirmBtn);
}

// --- Setup ---

beforeEach(() => {
  localStorage.clear();
  useGatewayStore.setState({
    client: null,
    state: 'disconnected',
    serverVersion: null,
    assistantName: 'Research-Claw',
    connId: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// Auto-save after OAuth success
// ============================================================

describe('OAuth auto-save flow', () => {
  it('calls onSuccess after oauth.complete succeeds', async () => {
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    const mockRequest = vi.fn()
      .mockResolvedValueOnce({ authUrl: 'https://auth.example.com', stateId: 'state-1' }) // rc.oauth.initiate
      .mockResolvedValueOnce({ ok: true }); // rc.oauth.complete

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    render(
      <OAuthModal
        open={true}
        provider="openai-codex"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    await completeOAuthFlow();

    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it('auto-closes modal after successful save', async () => {
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    const mockRequest = vi.fn()
      .mockResolvedValueOnce({ authUrl: 'https://auth.example.com', stateId: 'state-1' })
      .mockResolvedValueOnce({ ok: true });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    render(
      <OAuthModal
        open={true}
        provider="openai-codex"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    await completeOAuthFlow();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows saving message during auto-save', async () => {
    // Create a promise we can control to keep onSuccess pending
    let resolveOnSuccess!: () => void;
    const onSuccess = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveOnSuccess = resolve; }),
    );
    const onClose = vi.fn();

    const mockRequest = vi.fn()
      .mockResolvedValueOnce({ authUrl: 'https://auth.example.com', stateId: 'state-1' })
      .mockResolvedValueOnce({ ok: true });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    render(
      <OAuthModal
        open={true}
        provider="openai-codex"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    await completeOAuthFlow();

    // While onSuccess is pending, the saving message should be visible
    await waitFor(() => {
      expect(screen.getByText('oauth.successSaving')).toBeTruthy();
    });

    // Modal should NOT have closed yet
    expect(onClose).not.toHaveBeenCalled();

    // Now resolve the save
    resolveOnSuccess();
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error with manual close button when save fails', async () => {
    const onSuccess = vi.fn().mockRejectedValue(new Error('config.apply failed'));
    const onClose = vi.fn();

    const mockRequest = vi.fn()
      .mockResolvedValueOnce({ authUrl: 'https://auth.example.com', stateId: 'state-1' })
      .mockResolvedValueOnce({ ok: true });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    render(
      <OAuthModal
        open={true}
        provider="openai-codex"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    await completeOAuthFlow();

    // Should show the error and the fallback message
    await waitFor(() => {
      expect(screen.getByText('config.apply failed')).toBeTruthy();
      expect(screen.getByText('oauth.successTokenSaved')).toBeTruthy();
    });

    // Modal should NOT have auto-closed
    expect(onClose).not.toHaveBeenCalled();

    // Manual close button should be available
    const closeBtn = screen.getByText('oauth.close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('retains manual-close behavior without onSuccess', async () => {
    const onClose = vi.fn();

    const mockRequest = vi.fn()
      .mockResolvedValueOnce({ authUrl: 'https://auth.example.com', stateId: 'state-1' })
      .mockResolvedValueOnce({ ok: true });

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    render(
      <OAuthModal
        open={true}
        provider="openai-codex"
        onClose={onClose}
      />,
    );

    await completeOAuthFlow();

    // Should show the original success message (not auto-saving)
    await waitFor(() => {
      expect(screen.getByText('oauth.success')).toBeTruthy();
    });

    // Should show close button, not auto-close
    expect(onClose).not.toHaveBeenCalled();
    const closeBtn = screen.getByText('oauth.close');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onSuccess when oauth.complete fails', async () => {
    const onSuccess = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    const mockRequest = vi.fn()
      .mockResolvedValueOnce({ authUrl: 'https://auth.example.com', stateId: 'state-1' })
      .mockRejectedValueOnce(new Error('CSRF mismatch'));

    useGatewayStore.setState({
      client: createMockClient(mockRequest),
      state: 'connected',
    });

    render(
      <OAuthModal
        open={true}
        provider="openai-codex"
        onClose={onClose}
        onSuccess={onSuccess}
      />,
    );

    await completeOAuthFlow();

    // Should show the OAuth error, not trigger save
    await waitFor(() => {
      expect(screen.getByText('CSRF mismatch')).toBeTruthy();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
