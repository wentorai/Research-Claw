import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

import UploadConflictModal, { conflictActionToMode, type UploadConflict } from './UploadConflictModal';

// Mock i18next (same pattern as WorkspacePanel.test.tsx)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'count' in opts) return `${key}:${opts.count}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const FILE_CONFLICTS: UploadConflict[] = [
  { path: 'sources/a.pdf', existingType: 'file' },
  { path: 'sources/b.csv', existingType: 'file' },
];

function renderModal(conflicts: UploadConflict[]) {
  const onResolve = vi.fn();
  const onCancel = vi.fn();
  render(<UploadConflictModal open conflicts={conflicts} onResolve={onResolve} onCancel={onCancel} />);
  return { onResolve, onCancel };
}

describe('conflictActionToMode', () => {
  it('maps overwrite/rename through and skip/undefined to null', () => {
    expect(conflictActionToMode('overwrite')).toBe('overwrite');
    expect(conflictActionToMode('rename')).toBe('rename');
    expect(conflictActionToMode('skip')).toBeNull();
    expect(conflictActionToMode(undefined)).toBeNull();
  });
});

describe('UploadConflictModal', () => {
  it('defaults every conflict to keep-both (rename) and resolves the map on OK', () => {
    const { onResolve } = renderModal(FILE_CONFLICTS);
    expect(screen.getByText('workspace.conflictTitle:2')).toBeTruthy();
    fireEvent.click(screen.getByText('workspace.conflictStart'));
    const decisions = onResolve.mock.calls[0][0] as Map<string, string>;
    expect(decisions.get('sources/a.pdf')).toBe('rename');
    expect(decisions.get('sources/b.csv')).toBe('rename');
  });

  /** The nth radio INPUT with the given value (label-text clicks don't fire
   *  antd Radio changes in jsdom). */
  function radioInput(value: string, index: number): HTMLInputElement {
    const inputs = screen
      .getAllByRole('radio')
      .filter((el) => (el as HTMLInputElement).value === value) as HTMLInputElement[];
    return inputs[index];
  }

  it('apply-to-all (default on) spreads one choice to every row', () => {
    const { onResolve } = renderModal(FILE_CONFLICTS);
    fireEvent.click(radioInput('skip', 0));
    fireEvent.click(screen.getByText('workspace.conflictStart'));
    const decisions = onResolve.mock.calls[0][0] as Map<string, string>;
    expect(decisions.get('sources/a.pdf')).toBe('skip');
    expect(decisions.get('sources/b.csv')).toBe('skip');
  });

  it('unchecking apply-to-all scopes the choice to a single row', () => {
    const { onResolve } = renderModal(FILE_CONFLICTS);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(radioInput('skip', 1));
    fireEvent.click(screen.getByText('workspace.conflictStart'));
    const decisions = onResolve.mock.calls[0][0] as Map<string, string>;
    expect(decisions.get('sources/a.pdf')).toBe('rename');
    expect(decisions.get('sources/b.csv')).toBe('skip');
  });

  it('directory conflicts cannot be overwritten: option disabled, apply-all falls back to rename', () => {
    const conflicts: UploadConflict[] = [
      { path: 'sources/a.pdf', existingType: 'file' },
      { path: 'sources/data', existingType: 'directory' },
    ];
    const { onResolve } = renderModal(conflicts);
    // The directory row's overwrite radio input is disabled.
    const overwriteInputs = screen
      .getAllByRole('radio')
      .filter((el) => (el as HTMLInputElement).value === 'overwrite') as HTMLInputElement[];
    expect(overwriteInputs).toHaveLength(2);
    expect(overwriteInputs[1].disabled).toBe(true);

    // Apply-all overwrite: file row overwrites, directory row falls back to rename.
    fireEvent.click(overwriteInputs[0]);
    fireEvent.click(screen.getByText('workspace.conflictStart'));
    const decisions = onResolve.mock.calls[0][0] as Map<string, string>;
    expect(decisions.get('sources/a.pdf')).toBe('overwrite');
    expect(decisions.get('sources/data')).toBe('rename');
  });

  it('cancel invokes onCancel without resolving decisions', () => {
    const { onResolve, onCancel } = renderModal(FILE_CONFLICTS);
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
