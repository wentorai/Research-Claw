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
const mockSend = vi.fn();
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

const fullApproval: ApprovalCardType = {
  type: 'approval_card',
  action: 'Delete all draft files',
  context: 'User requested workspace cleanup',
  risk_level: 'medium',
  details: { path: '/workspace/drafts', count: 15 },
  approval_id: 'approval-001',
};

describe('ApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders title and action', () => {
    render(<ApprovalCard {...fullApproval} />);
    expect(screen.getByText('card.approval.title')).toBeInTheDocument();
    expect(screen.getByText('Delete all draft files')).toBeInTheDocument();
  });

  it('renders context', () => {
    render(<ApprovalCard {...fullApproval} />);
    expect(screen.getByText('User requested workspace cleanup')).toBeInTheDocument();
  });

  it('renders risk level', () => {
    render(<ApprovalCard {...fullApproval} />);
    expect(screen.getByText('card.approval.riskMedium')).toBeInTheDocument();
  });

  it('renders details when present', () => {
    render(<ApprovalCard {...fullApproval} />);
    expect(screen.getByText('path')).toBeInTheDocument();
    expect(screen.getByText('/workspace/drafts')).toBeInTheDocument();
  });

  it('hides details when not present', () => {
    render(<ApprovalCard {...fullApproval} details={undefined} />);
    expect(screen.queryByText('card.approval.details')).not.toBeInTheDocument();
  });

  it('shows approve and reject buttons', () => {
    render(<ApprovalCard {...fullApproval} />);
    expect(screen.getByText('card.approval.approve')).toBeInTheDocument();
    expect(screen.getByText('card.approval.reject')).toBeInTheDocument();
  });

  it('calls exec.approval.resolve with allow-once on approve click', async () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    render(<ApprovalCard {...fullApproval} />);
    fireEvent.click(screen.getByText('card.approval.approve'));
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('exec.approval.resolve', {
        id: 'approval-001',
        decision: 'allow-once',
      });
    });
  });

  it('calls exec.approval.resolve with deny on reject click', async () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    render(<ApprovalCard {...fullApproval} />);
    fireEvent.click(screen.getByText('card.approval.reject'));
    await waitFor(() => {
      expect(mockRequest).toHaveBeenCalledWith('exec.approval.resolve', {
        id: 'approval-001',
        decision: 'deny',
      });
    });
  });

  it('shows approved badge after approval', async () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    render(<ApprovalCard {...fullApproval} />);
    fireEvent.click(screen.getByText('card.approval.approve'));
    await waitFor(() => {
      expect(screen.getByText('card.approval.approved')).toBeInTheDocument();
    });
  });

  it('shows rejected badge after denial', async () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    render(<ApprovalCard {...fullApproval} />);
    fireEvent.click(screen.getByText('card.approval.reject'));
    await waitFor(() => {
      expect(screen.getByText('card.approval.rejected')).toBeInTheDocument();
    });
  });

  it('handles missing optional fields', () => {
    const minimal: ApprovalCardType = {
      type: 'approval_card',
      action: 'Run script',
      context: 'Agent needs permission',
      risk_level: 'low',
    };
    render(<ApprovalCard {...minimal} />);
    expect(screen.getByText('Run script')).toBeInTheDocument();
    expect(screen.getByText('card.approval.riskLow')).toBeInTheDocument();
  });

  it('renders high risk with warning icon', () => {
    render(<ApprovalCard {...fullApproval} risk_level="high" />);
    expect(screen.getByText('card.approval.riskHigh')).toBeInTheDocument();
  });

  it('calls onResolve callback', async () => {
    mockRequest.mockResolvedValueOnce({ ok: true });
    const onResolve = vi.fn();
    render(<ApprovalCard {...fullApproval} onResolve={onResolve} />);
    fireEvent.click(screen.getByText('card.approval.approve'));
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith('allow-once');
    });
  });
});
