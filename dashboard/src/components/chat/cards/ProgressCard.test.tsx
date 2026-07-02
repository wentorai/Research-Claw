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

const fullProgress: ProgressCardType = {
  type: 'progress_card',
  period: 'this_week',
  papers_read: 12,
  papers_added: 5,
  tasks_completed: 8,
  tasks_created: 3,
  writing_words: 2500,
  reading_minutes: 180,
  highlights: ['Finished literature review', 'Submitted draft to advisor'],
};

describe('ProgressCard', () => {
  it('renders title and period', () => {
    render(<ProgressCard {...fullProgress} />);
    expect(screen.getByText('card.progress.title')).toBeInTheDocument();
    expect(screen.getByText('this_week')).toBeInTheDocument();
  });

  it('renders all required metrics', () => {
    render(<ProgressCard {...fullProgress} />);
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('renders optional metrics when present', () => {
    render(<ProgressCard {...fullProgress} />);
    expect(screen.getByText('2500')).toBeInTheDocument();
    expect(screen.getByText('180')).toBeInTheDocument();
  });

  it('hides optional metrics when not present', () => {
    render(
      <ProgressCard
        {...fullProgress}
        writing_words={undefined}
        reading_minutes={undefined}
      />,
    );
    expect(screen.queryByText('card.progress.writingWords')).not.toBeInTheDocument();
    expect(screen.queryByText('card.progress.readingMinutes')).not.toBeInTheDocument();
  });

  it('renders highlights', () => {
    render(<ProgressCard {...fullProgress} />);
    expect(screen.getByText('Finished literature review')).toBeInTheDocument();
    expect(screen.getByText('Submitted draft to advisor')).toBeInTheDocument();
  });

  it('truncates very long highlights', () => {
    const longHighlight = 'A'.repeat(140);
    render(<ProgressCard {...fullProgress} highlights={[longHighlight]} />);
    expect(screen.queryByText(longHighlight)).not.toBeInTheDocument();
    expect(screen.getByText(/…$/)).toBeInTheDocument();
  });

  it('handles missing highlights gracefully', () => {
    render(<ProgressCard {...fullProgress} highlights={undefined} />);
    expect(screen.queryByText('card.progress.highlights')).not.toBeInTheDocument();
  });

  it('handles empty highlights array', () => {
    render(<ProgressCard {...fullProgress} highlights={[]} />);
    expect(screen.queryByText('card.progress.highlights')).not.toBeInTheDocument();
  });

  it('renders with minimal required fields', () => {
    const minimal: ProgressCardType = {
      type: 'progress_card',
      period: 'today',
      papers_read: 0,
      papers_added: 0,
      tasks_completed: 0,
      tasks_created: 0,
    };
    render(<ProgressCard {...minimal} />);
    expect(screen.getByText('card.progress.title')).toBeInTheDocument();
    expect(screen.getByText('today')).toBeInTheDocument();
  });

  it('uses i18n keys for all labels', () => {
    render(<ProgressCard {...fullProgress} />);
    expect(screen.getByText('card.progress.papersRead')).toBeInTheDocument();
    expect(screen.getByText('card.progress.papersAdded')).toBeInTheDocument();
    expect(screen.getByText('card.progress.tasksCompleted')).toBeInTheDocument();
    expect(screen.getByText('card.progress.tasksCreated')).toBeInTheDocument();
  });
});
