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
  monitor_name: 'Track protein folding',
  source_type: 'arxiv',
  target: 'q-bio.BM',
  schedule: '0 8 * * 1-5',
  total_found: 12,
  findings: [
    { title: 'AlphaFold3 Extensions for RNA', url: 'https://arxiv.org/abs/2603.12345', summary: 'Relevant to nucleic acid project' },
    { title: 'New Folding Dynamics Method', summary: 'Novel MD-based approach' },
  ],
};

describe('MonitorDigest', () => {
  it('renders monitor name and source type', () => {
    render(<MonitorDigest {...base} />);
    expect(screen.getByText('Track protein folding')).toBeInTheDocument();
    expect(screen.getByText('arxiv')).toBeInTheDocument();
  });

  it('renders total found count', () => {
    render(<MonitorDigest {...base} />);
    // i18n mock returns key with defaultValue fallback — check for the fallback text
    expect(screen.getByText(/12 result/i)).toBeInTheDocument();
  });

  it('renders target and schedule', () => {
    render(<MonitorDigest {...base} />);
    expect(screen.getByText('q-bio.BM')).toBeInTheDocument();
    expect(screen.getByText('0 8 * * 1-5')).toBeInTheDocument();
  });

  it('renders findings with titles', () => {
    render(<MonitorDigest {...base} />);
    expect(screen.getByText('AlphaFold3 Extensions for RNA')).toBeInTheDocument();
    expect(screen.getByText('New Folding Dynamics Method')).toBeInTheDocument();
  });

  it('renders finding URLs as links', () => {
    render(<MonitorDigest {...base} />);
    const link = screen.getByText('AlphaFold3 Extensions for RNA');
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://arxiv.org/abs/2603.12345');
  });

  it('renders findings without URL as plain text', () => {
    render(<MonitorDigest {...base} />);
    const el = screen.getByText('New Folding Dynamics Method');
    expect(el.tagName).not.toBe('A');
  });

  it('renders finding summaries', () => {
    render(<MonitorDigest {...base} />);
    expect(screen.getByText('Relevant to nucleic acid project')).toBeInTheDocument();
    expect(screen.getByText('Novel MD-based approach')).toBeInTheDocument();
  });

  it('hides findings section when findings is empty', () => {
    render(<MonitorDigest {...base} findings={[]} total_found={0} />);
    expect(screen.queryByText('card.monitor.findings')).not.toBeInTheDocument();
  });

  it('hides schedule when not provided', () => {
    render(<MonitorDigest {...base} schedule={undefined} />);
    expect(screen.queryByText('card.monitor.schedule')).not.toBeInTheDocument();
  });

  it('renders all 8 source types without crash', () => {
    const types = ['arxiv', 'semantic_scholar', 'github', 'rss', 'webpage', 'openalex', 'twitter', 'custom'];
    for (const st of types) {
      const { unmount } = render(<MonitorDigest {...base} source_type={st} />);
      expect(screen.getByText(st)).toBeInTheDocument();
      unmount();
    }
  });
});
