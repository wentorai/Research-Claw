import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';

import DestinationPickerModal, { type DirNode } from './DestinationPickerModal';

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

const TREE: DirNode[] = [
  {
    name: 'sources',
    path: 'sources',
    type: 'directory',
    children: [
      { name: 'papers', path: 'sources/papers', type: 'directory' },
      { name: 'a.pdf', path: 'sources/a.pdf', type: 'file' },
    ],
  },
  { name: 'outputs', path: 'outputs', type: 'directory' },
  { name: 'loose.txt', path: 'loose.txt', type: 'file' },
];

function renderPicker(overrides: Partial<React.ComponentProps<typeof DestinationPickerModal>> = {}) {
  const onResolve = vi.fn();
  const onCancel = vi.fn();
  const onCreateFolder = vi.fn(async (parent: string, name: string) => `${parent}/${name}`);
  render(
    <DestinationPickerModal
      open
      promptId={1}
      tree={TREE}
      hasFolders={false}
      defaultDest="sources"
      onCreateFolder={onCreateFolder}
      onResolve={onResolve}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onResolve, onCancel, onCreateFolder };
}

describe('DestinationPickerModal', () => {
  it('lists directories only (files excluded), nested dirs included', () => {
    renderPicker();
    const list = screen.getByTestId('dest-dir-list');
    expect(list.textContent).toContain('sources');
    expect(list.textContent).toContain('sources/papers');
    expect(list.textContent).toContain('outputs');
    expect(list.textContent).not.toContain('a.pdf');
    expect(list.textContent).not.toContain('loose.txt');
  });

  it('workspace root is the first option and resolves as empty dest', () => {
    const { onResolve } = renderPicker();
    const list = screen.getByTestId('dest-dir-list');
    expect(list.firstChild?.textContent).toContain('workspace.destRootLabel');
    fireEvent.click(screen.getByText('workspace.destRootLabel'));
    fireEvent.click(screen.getByText('workspace.destUpload'));
    expect(onResolve).toHaveBeenCalledWith({ dest: '', preserveRootName: false });
  });

  it('resolves the clicked directory on OK', () => {
    const { onResolve } = renderPicker();
    fireEvent.click(screen.getByText('sources/papers'));
    fireEvent.click(screen.getByText('workspace.destUpload'));
    expect(onResolve).toHaveBeenCalledWith({ dest: 'sources/papers', preserveRootName: false });
  });

  it('shows the keep-name toggle for folder drops, default ON', () => {
    const { onResolve } = renderPicker({ hasFolders: true });
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(screen.getByText('workspace.destUpload'));
    expect(onResolve).toHaveBeenCalledWith({ dest: 'sources', preserveRootName: true });
  });

  it('unchecking the toggle resolves preserveRootName false', () => {
    const { onResolve } = renderPicker({ hasFolders: true });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('workspace.destUpload'));
    expect(onResolve).toHaveBeenCalledWith({ dest: 'sources', preserveRootName: false });
  });

  it('falls back to scaffold dirs when the tree has no directories', () => {
    renderPicker({ tree: [{ name: 'x.txt', path: 'x.txt', type: 'file' }] });
    const list = screen.getByTestId('dest-dir-list');
    expect(list.textContent).toContain('sources');
    expect(list.textContent).toContain('outputs');
  });

  it('new folder creates under the selected dir and selects the result', async () => {
    let resolveCreate!: (path: string | null) => void;
    const onCreateFolder = vi.fn(
      () => new Promise<string | null>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const { onResolve } = renderPicker({ onCreateFolder });
    fireEvent.click(screen.getByText('sources/papers'));
    fireEvent.click(screen.getByText('workspace.destNewFolder'));
    const input = screen.getByPlaceholderText('workspace.destNewFolderIn') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'datasets' } });
    fireEvent.click(screen.getByText('workspace.destCreate'));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith('sources/papers', 'datasets'));
    const uploadButton = screen.getByText('workspace.destUpload').closest('button');
    expect(uploadButton).toBeDisabled();
    fireEvent.click(uploadButton!);
    expect(onResolve).not.toHaveBeenCalled();
    await act(async () => {
      resolveCreate('sources/papers/datasets');
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText('workspace.destNewFolderIn')).toBeNull(),
    );
    fireEvent.click(screen.getByText('workspace.destUpload'));
    await waitFor(() =>
      expect(onResolve).toHaveBeenCalledWith({ dest: 'sources/papers/datasets', preserveRootName: false }),
    );
  });

  it('keeps cancel usable while folder creation is pending', async () => {
    const onCreateFolder = vi.fn(() => new Promise<string | null>(() => {}));
    const { onResolve, onCancel } = renderPicker({ onCreateFolder });
    fireEvent.click(screen.getByText('workspace.destNewFolder'));
    fireEvent.change(screen.getByPlaceholderText('workspace.destNewFolderIn'), {
      target: { value: 'datasets' },
    });
    fireEvent.click(screen.getByText('workspace.destCreate'));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledTimes(1));

    const uploadButton = screen.getByText('workspace.destUpload').closest('button');
    expect(uploadButton).toBeDisabled();
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('ignores a stale create result after cancel and reopen', async () => {
    let resolveCreate!: (path: string | null) => void;
    const onCreateFolder = vi.fn(
      () => new Promise<string | null>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const onResolve = vi.fn();
    const onCancel = vi.fn();
    const renderModal = (open: boolean, defaultDest: string) => (
      <DestinationPickerModal
        open={open}
        promptId={1}
        tree={TREE}
        hasFolders={false}
        defaultDest={defaultDest}
        onCreateFolder={onCreateFolder}
        onResolve={onResolve}
        onCancel={onCancel}
      />
    );
    const view = render(renderModal(true, 'sources'));

    fireEvent.click(screen.getByText('sources/papers'));
    fireEvent.click(screen.getByText('workspace.destNewFolder'));
    fireEvent.change(screen.getByPlaceholderText('workspace.destNewFolderIn'), {
      target: { value: 'datasets' },
    });
    fireEvent.click(screen.getByText('workspace.destCreate'));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);

    view.rerender(renderModal(false, 'outputs'));
    view.rerender(renderModal(true, 'outputs'));
    await act(async () => {
      resolveCreate('sources/papers/datasets');
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('workspace.destUpload'));

    expect(onResolve).toHaveBeenCalledWith({ dest: 'outputs', preserveRootName: false });
  });

  it('isolates a replacement prompt while the modal stays open', async () => {
    let resolveCreate!: (path: string | null) => void;
    const onCreateFolder = vi.fn(
      () => new Promise<string | null>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const onResolve = vi.fn();
    const renderModal = (promptId: number, defaultDest: string) => (
      <DestinationPickerModal
        promptId={promptId}
        open
        tree={TREE}
        hasFolders={false}
        defaultDest={defaultDest}
        onCreateFolder={onCreateFolder}
        onResolve={onResolve}
        onCancel={vi.fn()}
      />
    );
    const view = render(renderModal(1, 'sources'));

    fireEvent.click(screen.getByText('sources/papers'));
    fireEvent.click(screen.getByText('workspace.destNewFolder'));
    fireEvent.change(screen.getByPlaceholderText('workspace.destNewFolderIn'), {
      target: { value: 'datasets' },
    });
    fireEvent.click(screen.getByText('workspace.destCreate'));
    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledTimes(1));

    view.rerender(renderModal(2, 'outputs'));
    await act(async () => {
      resolveCreate('sources/papers/datasets');
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('workspace.destUpload'));

    expect(onResolve).toHaveBeenCalledWith({ dest: 'outputs', preserveRootName: false });
  });

  it('cancel invokes onCancel without resolving', () => {
    const { onResolve, onCancel } = renderPicker();
    fireEvent.click(screen.getByText('common.cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onResolve).not.toHaveBeenCalled();
  });
});
