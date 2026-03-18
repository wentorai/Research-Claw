import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import MonitorDigest from './MonitorDigest';
import type { MonitorDigest as MonitorDigestType } from '@/types/cards';

vi.mock('@/stores/config', () => ({
  useConfigStore: (sel: (s: { theme: string }) => unknown) => sel({ theme: 'dark' }),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (sel: (s: { client: null }) => unknown) => sel({ client: null }),
}));

const base: MonitorDigestType = {
  type: 'monitor_digest',
  monitor_name: 'Test Monitor',
  source_type: 'github',
  target: 'openai/gpt-4',
  total_found: 5,
  findings: [
    { title: 'v4.1 Release', url: 'https://github.com/openai/gpt-4/releases/v4.1', summary: 'Major update' },
  ],
};

describe('MonitorDigest edge cases', () => {
  it('renders with zero findings gracefully', () => {
    render(<MonitorDigest {...base} total_found={0} findings={[]} />);
    expect(screen.getByText('Test Monitor')).toBeInTheDocument();
    expect(screen.queryByText('card.monitor.findings')).not.toBeInTheDocument();
  });

  it('renders very long monitor name', () => {
    const longName = 'A'.repeat(250);
    render(<MonitorDigest {...base} monitor_name={longName} />);
    expect(screen.getByText(longName)).toBeInTheDocument();
  });

  it('renders 15 findings without crash', () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({
      title: `Finding ${i + 1}`,
      summary: `Summary ${i + 1}`,
    }));
    render(<MonitorDigest {...base} total_found={15} findings={findings} />);
    expect(screen.getByText('Finding 1')).toBeInTheDocument();
    expect(screen.getByText('Finding 15')).toBeInTheDocument();
  });

  it('renders finding with only title (no url, no summary)', () => {
    render(<MonitorDigest {...base} findings={[{ title: 'Title Only' }]} />);
    expect(screen.getByText('Title Only')).toBeInTheDocument();
  });

  it('renders total_found = 999999', () => {
    render(<MonitorDigest {...base} total_found={999999} />);
    expect(screen.getByText(/999999 result/i)).toBeInTheDocument();
  });

  it('renders special characters in target', () => {
    render(<MonitorDigest {...base} target='https://example.com/feed?q=test&lang=en' />);
    expect(screen.getByText('https://example.com/feed?q=test&lang=en')).toBeInTheDocument();
  });

  it('renders unknown source_type with default color', () => {
    render(<MonitorDigest {...base} source_type="unknown_new_type" />);
    expect(screen.getByText('unknown_new_type')).toBeInTheDocument();
  });
});
