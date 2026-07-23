import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { App as AntApp } from 'antd';
import WorkspacePanel from './WorkspacePanel';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { uploadFileToWorkspace } from '../../gateway/upload';

// Mock the upload HTTP helper so drop tests can assert destinations.
vi.mock('../../gateway/upload', () => ({
  uploadFileToWorkspace: vi.fn(async (file: File, destination: string, nameOverride?: string) => ({
    name: nameOverride ?? file.name,
    path: `${destination}/${nameOverride ?? file.name}`,
    type: 'file',
    size: file.size,
    mime_type: '',
    modified_at: '',
    git_status: 'committed',
  })),
}));
const uploadMock = vi.mocked(uploadFileToWorkspace);

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'count' in opts) return `${key}:${opts.count}`;
      return key;
    },
    i18n: { changeLanguage: vi.fn() },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// Mock gateway store with a fake client
const mockRequest = vi.fn();

describe('WorkspacePanel', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    useConfigStore.setState({ theme: 'dark' });
    useGatewayStore.setState({
      client: null,
      state: 'disconnected',
      serverVersion: null,
    });
  });

  it('renders empty state when no data and no client', () => {
    render(<WorkspacePanel />);
    expect(screen.getByText('workspace.empty')).toBeTruthy();
  });

  it('renders upload button in empty state', () => {
    render(<WorkspacePanel />);
    expect(screen.getByText('workspace.upload')).toBeTruthy();
  });

  it('renders file tree section when tree data is loaded', async () => {
    // Provide a connected mock client that returns tree data
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.ws.tree') {
        return Promise.resolve({
          tree: [
            {
              name: 'sources',
              path: 'sources',
              type: 'directory',
              children: [
                { name: 'paper.pdf', path: 'sources/paper.pdf', type: 'file', git_status: 'committed' },
              ],
            },
          ],
          workspace_root: '/workspace',
        });
      }
      if (method === 'rc.ws.history') {
        return Promise.resolve({ commits: [], total: 0, has_more: false });
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({
      client: { isConnected: true, request: mockRequest } as any,
      state: 'connected',
    });

    render(<WorkspacePanel />);

    // Wait for async data load
    const fileTreeLabel = await screen.findByText('workspace.fileTree');
    expect(fileTreeLabel).toBeTruthy();
    expect(await screen.findByText('sources')).toBeTruthy();
    expect(await screen.findByText('paper.pdf')).toBeTruthy();
  });

  it('renders recent changes when commits exist', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.ws.tree') {
        return Promise.resolve({ tree: [], workspace_root: '/workspace' });
      }
      if (method === 'rc.ws.history') {
        return Promise.resolve({
          commits: [
            {
              hash: 'abc123',
              short_hash: 'abc1',
              message: 'Add introduction section',
              author: 'User',
              timestamp: new Date(Date.now() - 3600000).toISOString(),
              files_changed: 2,
            },
          ],
          total: 1,
          has_more: false,
        });
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({
      client: { isConnected: true, request: mockRequest } as any,
      state: 'connected',
    });

    render(<WorkspacePanel />);

    expect(await screen.findByText('workspace.recentChanges')).toBeTruthy();
    expect(await screen.findByText('Add introduction section')).toBeTruthy();
  });

  it('renders drag-drop zone when data exists', async () => {
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.ws.tree') {
        return Promise.resolve({
          tree: [{ name: 'file.tex', path: 'file.tex', type: 'file' }],
          workspace_root: '/workspace',
        });
      }
      if (method === 'rc.ws.history') {
        return Promise.resolve({ commits: [], total: 0, has_more: false });
      }
      return Promise.resolve({});
    });

    useGatewayStore.setState({
      client: { isConnected: true, request: mockRequest } as any,
      state: 'connected',
    });

    render(<WorkspacePanel />);

    expect(await screen.findByText('workspace.dragDrop')).toBeTruthy();
  });
});

// ============================================================
// External file drag-over waiting state
// ============================================================

describe('WorkspacePanel — external file drag-over state', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.ws.tree') {
        return Promise.resolve({
          tree: [{ name: 'file.tex', path: 'file.tex', type: 'file' }],
          workspace_root: '/workspace',
        });
      }
      if (method === 'rc.ws.history') {
        return Promise.resolve({ commits: [], total: 0, has_more: false });
      }
      return Promise.resolve({});
    });
    useConfigStore.setState({ theme: 'dark' });
    useGatewayStore.setState({
      client: { isConnected: true, request: mockRequest } as any,
      state: 'connected',
    });
  });

  it('shows "dropToUpload" text when external files are dragged over', async () => {
    render(<WorkspacePanel />);
    await screen.findByText('workspace.dragDrop'); // default state

    // Simulate external file drag enter
    const panel = screen.getByText('workspace.dragDrop').closest('div[style*="height: 100%"]')!;
    const dragEnterEvent = new Event('dragenter', { bubbles: true });
    Object.defineProperty(dragEnterEvent, 'dataTransfer', {
      value: { types: ['Files'], dropEffect: 'none', files: [] },
    });
    act(() => { panel.dispatchEvent(dragEnterEvent); });

    expect(screen.getByText('workspace.dropToUpload')).toBeTruthy();
  });

  it('hides "dropToUpload" after drag leave', async () => {
    render(<WorkspacePanel />);
    await screen.findByText('workspace.dragDrop');

    const panel = screen.getByText('workspace.dragDrop').closest('div[style*="height: 100%"]')!;

    // Enter
    const enterEvent = new Event('dragenter', { bubbles: true });
    Object.defineProperty(enterEvent, 'dataTransfer', {
      value: { types: ['Files'], dropEffect: 'none', files: [] },
    });
    act(() => { panel.dispatchEvent(enterEvent); });
    expect(screen.getByText('workspace.dropToUpload')).toBeTruthy();

    // Leave
    const leaveEvent = new Event('dragleave', { bubbles: true });
    Object.defineProperty(leaveEvent, 'dataTransfer', {
      value: { types: ['Files'], dropEffect: 'none', files: [] },
    });
    act(() => { panel.dispatchEvent(leaveEvent); });
    expect(screen.queryByText('workspace.dropToUpload')).toBeNull();
    expect(screen.getByText('workspace.dragDrop')).toBeTruthy();
  });

  it('does NOT show "dropToUpload" for internal workspace drags', async () => {
    render(<WorkspacePanel />);
    await screen.findByText('workspace.dragDrop');

    const panel = screen.getByText('workspace.dragDrop').closest('div[style*="height: 100%"]')!;

    // Internal drag (has text/x-workspace-path type)
    const internalEvent = new Event('dragenter', { bubbles: true });
    Object.defineProperty(internalEvent, 'dataTransfer', {
      value: { types: ['text/x-workspace-path', 'Files'], dropEffect: 'none', files: [] },
    });
    act(() => { panel.dispatchEvent(internalEvent); });

    // Should still show default drag zone, not dropToUpload
    expect(screen.queryByText('workspace.dropToUpload')).toBeNull();
  });
});

// ============================================================
// T4 — destination picker + Finder-style node drops
// ============================================================

describe('WorkspacePanel — destination picker & node drops', () => {
  // Real antd App provider so message/modal toasts exist (these flows toast).
  const renderPanel = () => render(<AntApp><WorkspacePanel /></AntApp>);
  const dropEvent = (dataTransfer: Record<string, unknown>) => {
    const ev = new Event('drop', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
    return ev;
  };
  const externalDT = (files: File[]) => ({
    types: ['Files'],
    files,
    dropEffect: 'none',
    getData: () => '',
  });
  /** webkitGetAsEntry items for a folder "myfolder" containing a.txt. */
  const folderDT = () => {
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      name: 'a.txt',
      file: (cb: (f: File) => void) => cb(new File(['x'], 'a.txt')),
    };
    let served = false;
    const dirEntry = {
      isFile: false,
      isDirectory: true,
      name: 'myfolder',
      createReader: () => ({
        readEntries: (cb: (entries: unknown[]) => void) => {
          cb(served ? [] : [fileEntry]);
          served = true;
        },
      }),
    };
    return {
      types: ['Files'],
      files: [],
      dropEffect: 'none',
      getData: () => '',
      items: [{ webkitGetAsEntry: () => dirEntry }],
    };
  };

  beforeEach(() => {
    uploadMock.mockClear();
    mockRequest.mockReset();
    mockRequest.mockImplementation((method: string) => {
      if (method === 'rc.ws.tree') {
        return Promise.resolve({
          tree: [
            {
              name: 'sources',
              path: 'sources',
              type: 'directory',
              children: [{ name: 'paper.pdf', path: 'sources/paper.pdf', type: 'file' }],
            },
            { name: 'notes', path: 'notes', type: 'directory', children: [] },
          ],
          workspace_root: '/workspace',
        });
      }
      if (method === 'rc.ws.history') {
        return Promise.resolve({ commits: [], total: 0, has_more: false });
      }
      if (method === 'rc.ws.exists') {
        return Promise.resolve({ exists: false });
      }
      return Promise.resolve({});
    });
    useConfigStore.setState({ theme: 'dark' });
    useGatewayStore.setState({
      client: { isConnected: true, request: mockRequest } as any,
      state: 'connected',
    });
  });

  it('external drop on a folder node uploads INTO that folder without the picker', async () => {
    renderPanel();
    const notesRow = await screen.findByText('notes');

    act(() => {
      notesRow.dispatchEvent(dropEvent(externalDT([new File(['x'], 'a.txt')])));
    });

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][1]).toBe('notes');
    expect(uploadMock.mock.calls[0][2]).toBe('a.txt');
    expect(screen.queryByText('workspace.destTitle')).toBeNull();
  });

  it('external drop on empty space opens the destination picker, then uploads to the chosen dir', async () => {
    renderPanel();
    await screen.findByText('notes');
    const panel = screen.getByText('workspace.fileTree').closest('div[style*="height: 100%"]')!;

    act(() => {
      panel.dispatchEvent(dropEvent(externalDT([new File(['x'], 'b.txt')])));
    });

    await screen.findByText('workspace.destTitle');
    expect(uploadMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('workspace.destUpload'));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][1]).toBe('sources'); // default = last-used/sources
  });

  it('folder drop via the picker preserves the top-level folder name by default', async () => {
    renderPanel();
    await screen.findByText('notes');
    const panel = screen.getByText('workspace.fileTree').closest('div[style*="height: 100%"]')!;

    act(() => {
      panel.dispatchEvent(dropEvent(folderDT()));
    });

    await screen.findByText('workspace.destTitle');
    // Folder drop → keep-name toggle visible and checked by default.
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    fireEvent.click(screen.getByText('workspace.destUpload'));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][1]).toBe('sources/myfolder');
    expect(uploadMock.mock.calls[0][2]).toBe('a.txt');
  });

  it('internal drag onto a folder node still moves and never uploads', async () => {
    renderPanel();
    const notesRow = await screen.findByText('notes');

    act(() => {
      notesRow.dispatchEvent(
        dropEvent({
          types: ['text/x-workspace-path'],
          files: [],
          dropEffect: 'none',
          getData: () => 'sources/paper.pdf',
        }),
      );
    });

    await waitFor(() =>
      expect(mockRequest).toHaveBeenCalledWith('rc.ws.move', { from: 'sources/paper.pdf', to: 'notes/paper.pdf' }),
    );
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('node-targeted drop clears the external drag overlay', async () => {
    renderPanel();
    const notesRow = await screen.findByText('notes');
    const panel = screen.getByText('workspace.fileTree').closest('div[style*="height: 100%"]')!;

    const enterEvent = new Event('dragenter', { bubbles: true });
    Object.defineProperty(enterEvent, 'dataTransfer', { value: { types: ['Files'], dropEffect: 'none', files: [] } });
    act(() => { panel.dispatchEvent(enterEvent); });
    expect(screen.getByText('workspace.dropToUpload')).toBeTruthy();

    act(() => {
      notesRow.dispatchEvent(dropEvent(externalDT([new File(['x'], 'c.txt')])));
    });

    await waitFor(() => expect(uploadMock).toHaveBeenCalled());
    expect(screen.queryByText('workspace.dropToUpload')).toBeNull();
  });
});
