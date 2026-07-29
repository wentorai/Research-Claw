import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { App as AntApp } from 'antd';
import WorkspacePanel, {
  InlineNameInput,
  RenameInput,
  replaceOwnedPrompt,
  settleOwnedPrompt,
  type DestinationPromptState,
  type OwnedPromptState,
} from './WorkspacePanel';
import type { DestinationChoice } from './DestinationPickerModal';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { getThemeTokens } from '../../styles/theme';
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
// Destination prompt ownership
// ============================================================

describe('WorkspacePanel — destination prompt ownership', () => {
  it('atomically replaces the owner and ignores stale settlement', () => {
    let rendered: DestinationPromptState | null = null;
    const ref: { current: DestinationPromptState | null } = { current: null };
    const setPrompt: React.Dispatch<React.SetStateAction<DestinationPromptState | null>> = (next) => {
      rendered = typeof next === 'function' ? next(rendered) : next;
    };
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    const first: DestinationPromptState = { id: 1, hasFolders: false, resolve: firstResolve };
    const second: DestinationPromptState = { id: 2, hasFolders: true, resolve: secondResolve };

    replaceOwnedPrompt<DestinationChoice, DestinationPromptState>(ref, setPrompt, first);
    replaceOwnedPrompt<DestinationChoice, DestinationPromptState>(ref, setPrompt, second);
    expect(firstResolve).toHaveBeenCalledWith(null);
    expect(ref.current).toBe(second);
    expect(rendered).toBe(second);

    expect(
      settleOwnedPrompt<DestinationChoice, DestinationPromptState>(ref, setPrompt, first.id, null),
    ).toBe(false);
    expect(ref.current).toBe(second);
    expect(rendered).toBe(second);
    expect(secondResolve).not.toHaveBeenCalled();

    const choice = { dest: 'outputs', preserveRootName: false };
    expect(
      settleOwnedPrompt<DestinationChoice, DestinationPromptState>(
        ref,
        setPrompt,
        second.id,
        choice,
      ),
    ).toBe(true);
    expect(ref.current).toBeNull();
    expect(rendered).toBeNull();
    expect(secondResolve).toHaveBeenCalledWith(choice);
  });

  it('uses the same ownership rules for conflict decisions', () => {
    type ConflictPrompt = OwnedPromptState<Map<string, 'skip' | 'overwrite'>> & {
      conflicts: string[];
    };
    let rendered: ConflictPrompt | null = null;
    const ref: { current: ConflictPrompt | null } = { current: null };
    const setPrompt: React.Dispatch<React.SetStateAction<ConflictPrompt | null>> = (next) => {
      rendered = typeof next === 'function' ? next(rendered) : next;
    };
    const firstResolve = vi.fn();
    const secondResolve = vi.fn();
    const first: ConflictPrompt = { id: 1, conflicts: ['a.pdf'], resolve: firstResolve };
    const second: ConflictPrompt = { id: 2, conflicts: ['b.pdf'], resolve: secondResolve };

    replaceOwnedPrompt<Map<string, 'skip' | 'overwrite'>, ConflictPrompt>(
      ref,
      setPrompt,
      first,
    );
    replaceOwnedPrompt<Map<string, 'skip' | 'overwrite'>, ConflictPrompt>(
      ref,
      setPrompt,
      second,
    );
    expect(firstResolve).toHaveBeenCalledWith(null);
    expect(
      settleOwnedPrompt<Map<string, 'skip' | 'overwrite'>, ConflictPrompt>(
        ref,
        setPrompt,
        first.id,
        new Map(),
      ),
    ).toBe(false);
    expect(ref.current).toBe(second);
    expect(rendered).toBe(second);

    const decisions = new Map([['b.pdf', 'overwrite' as const]]);
    expect(
      settleOwnedPrompt<Map<string, 'skip' | 'overwrite'>, ConflictPrompt>(
        ref,
        setPrompt,
        second.id,
        decisions,
      ),
    ).toBe(true);
    expect(ref.current).toBeNull();
    expect(rendered).toBeNull();
    expect(secondResolve).toHaveBeenCalledWith(decisions);
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
    localStorage.removeItem('rc.ws.lastUploadDest'); // remember-last leaks across tests otherwise
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

  it('choosing workspace root in the picker sends "." as the wire destination', async () => {
    renderPanel();
    await screen.findByText('notes');
    const panel = screen.getByText('workspace.fileTree').closest('div[style*="height: 100%"]')!;

    act(() => {
      panel.dispatchEvent(dropEvent(externalDT([new File(['x'], 'root.txt')])));
    });

    await screen.findByText('workspace.destTitle');
    fireEvent.click(screen.getByText('workspace.destRootLabel'));
    fireEvent.click(screen.getByText('workspace.destUpload'));
    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(uploadMock.mock.calls[0][1]).toBe('.');
    expect(uploadMock.mock.calls[0][2]).toBe('root.txt');
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

// ---------------------------------------------------------------------------
// IME composition guards (CJK input) — 项目强制规则:
// "Guard all keyboard handlers against IME composition events".
//
// 回归目标:这两个 onKeyDown 的守卫曾经只挂在 Enter 分支上,Escape 分支写在守卫
// 之前且直接 return —— 中文命名文件/文件夹时按 Esc 关候选窗会连带销毁编辑器,
// 已输入内容全部丢弃。守卫必须置顶,同时覆盖 Escape 与 Enter。
//
// 三个合成信号都要拦:onCompositionStart 置的内部标志、nativeEvent.isComposing、
// keyCode === 229(部分浏览器/输入法只给这一路信号)。
// ---------------------------------------------------------------------------

const imeTokens = getThemeTokens('dark');

describe('WorkspacePanel InlineNameInput — IME 合成守卫 (新建/内联编辑)', () => {
  function renderInline() {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <InlineNameInput
        defaultValue=""
        icon={null}
        iconColor="#71717A"
        depth={0}
        tokens={imeTokens}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    return { input, onConfirm, onCancel };
  }

  it('合成期(compositionStart 已置位)按 Escape 不得销毁编辑器', () => {
    const { input, onCancel, onConfirm } = renderInline();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '实验数据' } });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('合成期(nativeEvent.isComposing)按 Escape 不得销毁编辑器', () => {
    const { input, onCancel } = renderInline();
    fireEvent.change(input, { target: { value: '实验数据' } });

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('合成期(keyCode=229)按 Escape 不得销毁编辑器', () => {
    const { input, onCancel } = renderInline();
    fireEvent.change(input, { target: { value: '实验数据' } });

    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('合成期按 Enter 不得提交半成品名字', () => {
    const { input, onConfirm, onCancel } = renderInline();
    fireEvent.change(input, { target: { value: '实验数' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('非合成期按 Escape 照常取消(守卫不得误伤主路径)', () => {
    const { input, onCancel } = renderInline();
    fireEvent.change(input, { target: { value: '实验数据' } });

    fireEvent.keyDown(input, { key: 'Escape', isComposing: false });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('非合成期按 Enter 照常提交(守卫不得误伤主路径)', () => {
    const { input, onConfirm } = renderInline();
    fireEvent.change(input, { target: { value: '实验数据' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

    expect(onConfirm).toHaveBeenCalledWith('实验数据');
  });

  it('合成结束(compositionEnd)后 Escape 恢复正常取消', () => {
    const { input, onCancel } = renderInline();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '实验数据' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('WorkspacePanel RenameInput — IME 合成守卫 (重命名)', () => {
  function renderRename() {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <RenameInput
        defaultValue="paper.pdf"
        isFile
        tokens={imeTokens}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    return { input, onConfirm, onCancel };
  }

  it('合成期(compositionStart 置 dataset.composing)按 Escape 不得取消重命名', () => {
    const { input, onCancel, onConfirm } = renderRename();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '论文终稿' } });

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('合成期(nativeEvent.isComposing)按 Escape 不得取消重命名', () => {
    const { input, onCancel } = renderRename();
    fireEvent.change(input, { target: { value: '论文终稿' } });

    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('合成期(keyCode=229)按 Escape 不得取消重命名', () => {
    const { input, onCancel } = renderRename();
    fireEvent.change(input, { target: { value: '论文终稿' } });

    fireEvent.keyDown(input, { key: 'Escape', keyCode: 229 });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('合成期按 Enter 不得提交半成品名字', () => {
    const { input, onConfirm, onCancel } = renderRename();
    fireEvent.change(input, { target: { value: '论文终' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('非合成期按 Escape 照常取消(守卫不得误伤主路径)', () => {
    const { input, onCancel } = renderRename();
    fireEvent.change(input, { target: { value: '论文终稿' } });

    fireEvent.keyDown(input, { key: 'Escape', isComposing: false });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('非合成期按 Enter 照常提交(守卫不得误伤主路径)', () => {
    const { input, onConfirm } = renderRename();
    fireEvent.change(input, { target: { value: '论文终稿.pdf' } });

    fireEvent.keyDown(input, { key: 'Enter', isComposing: false });

    expect(onConfirm).toHaveBeenCalledWith('论文终稿.pdf');
  });

  it('合成结束(compositionEnd)后 Escape 恢复正常取消', () => {
    const { input, onCancel } = renderRename();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '论文终稿' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
