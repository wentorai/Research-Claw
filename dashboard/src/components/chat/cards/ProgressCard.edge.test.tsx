/**
 * ProgressCard edge case tests
 * Covers: all optional fields, many highlights, zero metrics, custom period
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ProgressCard from './ProgressCard';
import type { ProgressCard as ProgressCardType } from '@/types/cards';

// Mock i18n
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/stores/config', () => ({
  useConfigStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: 'dark' }),
}));

describe('ProgressCard edge cases', () => {
  it('renders with all optional fields present', () => {
    const full: ProgressCardType = {
      type: 'progress_card',
      period: 'this_month',
      papers_read: 50,
      papers_added: 20,
      tasks_completed: 30,
      tasks_created: 10,
      writing_words: 15000,
      reading_minutes: 600,
      highlights: ['Completed survey', 'Published paper'],
    };
    render(<ProgressCard {...full} />);
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('15000')).toBeInTheDocument();
    expect(screen.getByText('600')).toBeInTheDocument();
    expect(screen.getByText('Completed survey')).toBeInTheDocument();
    expect(screen.getByText('Published paper')).toBeInTheDocument();
  });

  it('renders with 10+ highlight items without crash', () => {
    const manyHighlights: ProgressCardType = {
      type: 'progress_card',
      period: 'session',
      papers_read: 1,
      papers_added: 1,
      tasks_completed: 1,
      tasks_created: 1,
      highlights: Array.from({ length: 15 }, (_, i) => `Highlight ${i + 1}`),
    };
    render(<ProgressCard {...manyHighlights} />);
    expect(screen.getByText('Highlight 1')).toBeInTheDocument();
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Highlight ${i}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('Highlight 6')).not.toBeInTheDocument();
    expect(screen.queryByText('Highlight 15')).not.toBeInTheDocument();
    expect(screen.getByText('card.progress.moreHighlights')).toBeInTheDocument();
  });

  it('renders zero values for all metrics', () => {
    const zeros: ProgressCardType = {
      type: 'progress_card',
      period: 'today',
      papers_read: 0,
      papers_added: 0,
      tasks_completed: 0,
      tasks_created: 0,
      writing_words: 0,
      reading_minutes: 0,
    };
    render(<ProgressCard {...zeros} />);
    // All four 0s should be rendered (there are 6 zeros total)
    const allZeros = screen.getAllByText('0');
    expect(allZeros.length).toBe(6);
  });

  it('renders with custom period label', () => {
    const custom: ProgressCardType = {
      type: 'progress_card',
      period: 'March 1-11, 2026',
      papers_read: 5,
      papers_added: 2,
      tasks_completed: 3,
      tasks_created: 1,
    };
    render(<ProgressCard {...custom} />);
    expect(screen.getByText('March 1-11, 2026')).toBeInTheDocument();
  });

  it('hides highlights section when highlights is undefined', () => {
    const noHighlights: ProgressCardType = {
      type: 'progress_card',
      period: 'today',
      papers_read: 1,
      papers_added: 0,
      tasks_completed: 0,
      tasks_created: 0,
    };
    render(<ProgressCard {...noHighlights} />);
    expect(screen.queryByText('card.progress.highlights')).not.toBeInTheDocument();
  });

  it('renders large metric values', () => {
    const large: ProgressCardType = {
      type: 'progress_card',
      period: 'lifetime',
      papers_read: 99999,
      papers_added: 88888,
      tasks_completed: 77777,
      tasks_created: 66666,
    };
    render(<ProgressCard {...large} />);
    expect(screen.getByText('99999')).toBeInTheDocument();
    expect(screen.getByText('88888')).toBeInTheDocument();
  });
});
