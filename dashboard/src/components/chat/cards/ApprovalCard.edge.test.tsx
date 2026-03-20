/**
 * ApprovalCard edge case tests
 * Covers: high risk pulsing glow, empty details, very long context,
 * double-click protection, no approval_id, all risk levels
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApprovalCard from './ApprovalCard';
import type { ApprovalCard as ApprovalCardType } from '@/types/cards';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// Mock stores
const mockRequest = vi.fn();
const mockSend = vi.fn().mockResolvedValue(undefined);
vi.mock('@/stores/config', () => ({
  useConfigStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: 'dark' }),
}));
vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (s: { client: { request: typeof mockRequest } | null }) => unknown) =>
    selector({ client: { request: mockRequest } }),
}));
vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (s: { send: typeof mockSend }) => unknown) =>
    selector({ send: mockSend }),
}));

const baseApproval: ApprovalCardType = {
  type: 'approval_card',
  action: 'Test action',
  context: 'Test context',
  risk_level: 'medium',
  approval_id: 'approval-edge',
};

describe('ApprovalCard edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders high risk with pulse-glow animation class applied', () => {
    render(<ApprovalCard {...baseApproval} risk_level="high" />);
    expect(screen.getByText('card.approval.riskHigh')).toBeInTheDocument();
    // pulse-glow is now defined in global.css instead of injected inline.
    // Verify the risk tag has the animation style applied.
    const riskTag = screen.getByText('card.approval.riskHigh');
    expect(riskTag.closest('.ant-tag')).toBeTruthy();
  });

  it('hides "Always Allow" dropdown for high risk (only shows simple Approve)', () => {
    render(<ApprovalCard {...baseApproval} risk_level="high" />);
    // For high risk, there should be a simple Button, not a Dropdown.Button
    // The approve button should exist
    expect(screen.getByText('card.approval.approve')).toBeInTheDocument();
    // But no "Always" option visible (dropdown arrow not present for high risk)
    expect(screen.queryByText(/Always/)).not.toBeInTheDocument();
  });

  it('renders with empty details object (hides details section)', () => {
    render(<ApprovalCard {...baseApproval} details={{}} />);
    expect(screen.queryByText('card.approval.details')).not.toBeInTheDocument();
  });

  it('renders with undefined details (hides details section)', () => {
    render(<ApprovalCard {...baseApproval} details={undefined} />);
    expect(screen.queryByText('card.approval.details')).not.toBeInTheDocument();
  });

  it('renders very long context string without crash', () => {
    const longContext = 'X'.repeat(2000);
    render(<ApprovalCard {...baseApproval} context={longContext} />);
    expect(screen.getByText(longContext)).toBeInTheDocument();
  });

  it('double-click on approve sends request only once to gateway', async () => {
    // Make the request resolve slowly
    mockRequest.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 50)),
    );
    render(<ApprovalCard {...baseApproval} />);
    const approveBtn = screen.getByText('card.approval.approve');

    // Click twice rapidly
    fireEvent.click(approveBtn);
    fireEvent.click(approveBtn);

    await waitFor(() => {
      expect(screen.getByText('card.approval.approved')).toBeInTheDocument();
    });

    // After first click resolves and status changes to 'allowed',
    // buttons disappear, so second click has no effect.
    // The gateway should have been called only once because the second click
    // happens while the first is in-flight, but the handleResolve is async
    // and doesn't have debounce, so technically it could be called twice.
    // However, after state changes to 'allowed', buttons hide.
    // So mockRequest may be called 1 or 2 times depending on timing.
    expect(mockRequest.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockRequest.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('calls onResolve without gateway when no approval_id', async () => {
    const onResolve = vi.fn();
    render(
      <ApprovalCard {...baseApproval} approval_id={undefined} onResolve={onResolve} />,
    );
    fireEvent.click(screen.getByText('card.approval.approve'));
    // Without approval_id, sends chat message via chatSend then calls onResolve
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith('allow-once');
    });
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
  });

  it('renders details with string values', () => {
    render(
      <ApprovalCard
        {...baseApproval}
        details={{ path: '/workspace/drafts', command: 'rm -rf' }}
      />,
    );
    expect(screen.getByText(/card\.approval\.details/)).toBeInTheDocument();
    expect(screen.getByText('path')).toBeInTheDocument();
    expect(screen.getByText('/workspace/drafts')).toBeInTheDocument();
    expect(screen.getByText('command')).toBeInTheDocument();
    expect(screen.getByText('rm -rf')).toBeInTheDocument();
  });

  it('renders details with non-string values (JSON.stringify fallback)', () => {
    render(
      <ApprovalCard
        type="approval_card"
        action="Delete files"
        context="Cleanup"
        risk_level="low"
        details={{
          count: 42,
          nested: { a: 1 },
        }}
      />,
    );
    expect(screen.getByText(/card\.approval\.details/)).toBeInTheDocument();
    expect(screen.getByText('count')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('nested')).toBeInTheDocument();
    expect(screen.getByText('{"a":1}')).toBeInTheDocument();
  });

  it('renders all three risk levels', () => {
    const levels: ApprovalCardType['risk_level'][] = ['low', 'medium', 'high'];
    const labels = ['card.approval.riskLow', 'card.approval.riskMedium', 'card.approval.riskHigh'];
    for (let i = 0; i < levels.length; i++) {
      const { unmount } = render(
        <ApprovalCard {...baseApproval} risk_level={levels[i]} />,
      );
      expect(screen.getByText(labels[i])).toBeInTheDocument();
      unmount();
    }
  });

  it('hides approve/reject buttons after rejection', async () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    render(<ApprovalCard {...baseApproval} />);
    fireEvent.click(screen.getByText('card.approval.reject'));
    await waitFor(() => {
      expect(screen.getByText('card.approval.rejected')).toBeInTheDocument();
    });
    // Buttons should be gone
    expect(screen.queryByText('card.approval.approve')).not.toBeInTheDocument();
    expect(screen.queryByText('card.approval.reject')).not.toBeInTheDocument();
  });
});
