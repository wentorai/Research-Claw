import React from 'react';
import { ConfigProvider } from 'antd';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import MessageInput from './MessageInput';
import { useChatStore } from '../../stores/chat';
import { useConfigStore } from '../../stores/config';
import { useGatewayStore } from '../../stores/gateway';
import { useUiStore } from '../../stores/ui';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  warning: vi.fn(),
  confirm: vi.fn(),
  vision: { supportsImage: true as boolean | 'unknown' },
}));

vi.mock('../../gateway/upload', () => ({
  uploadFileToWorkspace: mocks.upload,
}));

vi.mock('../../hooks/useVisionSupport', () => ({
  useVisionSupport: () => ({ supportsImage: mocks.vision.supportsImage, source: 'config', modelRef: 'test/vision' }),
}));

vi.mock('react-i18next', () => {
  const translations: Record<string, string> = {
    'chat.attachAttachment': 'Add attachment',
    'chat.selectFiles': 'Select files',
    'chat.selectFolder': 'Select folder',
    'chat.attachNoVisionModel': 'Image attached. The current model cannot view images directly.',
  };
  return {
    useTranslation: () => ({
      t: (key: string, options?: { defaultValue?: string }) => translations[key] ?? options?.defaultValue ?? key,
      i18n: { language: 'en', changeLanguage: vi.fn() },
    }),
    initReactI18next: { type: '3rdParty', init: vi.fn() },
  };
});

vi.mock('antd', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antd')>();
  return {
    ...actual,
    message: {
      ...actual.message,
      warning: mocks.warning,
      success: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
    },
    App: {
      ...actual.App,
      useApp: () => ({
        modal: { confirm: mocks.confirm },
        message: { warning: mocks.warning, success: vi.fn(), error: vi.fn(), info: vi.fn() },
        notification: { open: vi.fn() },
      }),
    },
  };
});

const gatewayRequest = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({}));

function sizedFile(name: string, type: string, size?: number): File {
  const file = new File(['content'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function folderFile(name: string, type: string, relativePath: string): File {
  const file = sizedFile(name, type);
  Object.defineProperty(file, 'webkitRelativePath', { value: relativePath });
  return file;
}

function renderComposer() {
  return render(
    <ConfigProvider>
      <MessageInput />
    </ConfigProvider>,
  );
}

function fileInputs(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'));
}

describe('MessageInput attachment picker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.vision.supportsImage = true;
    mocks.upload.mockImplementation(async (file: File, destination: string, fileName?: string) => ({
      name: fileName ?? file.name,
      path: `${destination}/${fileName ?? file.name}`,
      type: 'file',
      size: file.size,
      mime_type: file.type,
      modified_at: '',
      git_status: '',
    }));
    useGatewayStore.setState({
      state: 'connected',
      client: { isConnected: true, request: gatewayRequest } as never,
    });
    useConfigStore.setState({ gatewayConfig: {} as never, systemPromptAppend: '' });
    useChatStore.setState({
      messages: [],
      sending: false,
      streaming: false,
      compacting: false,
      streamText: null,
      runId: null,
      sessionKey: 'main',
      lastError: null,
      _lastSentDraft: null,
      inputRestore: null,
      inputRestoreSeq: 0,
      _pendingUserMsgs: [],
      _localOnlyMsgs: [],
    });
    useUiStore.setState({ chatInputPrefill: null, chatAttachmentPrefill: null });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.querySelectorAll('.ant-dropdown').forEach((node) => node.remove());
  });

  it('exposes an accessible Add attachment button and a keyboard-capable two-action menu', async () => {
    renderComposer();

    const trigger = screen.getByRole('button', { name: 'Add attachment' });
    fireEvent.click(trigger);

    expect(await screen.findByText('Select files')).toBeInTheDocument();
    expect(await screen.findByText('Select folder')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('renders an arbitrary multiple-file input and a webkitdirectory folder input', () => {
    const { container } = renderComposer();
    const inputs = fileInputs(container);

    expect(inputs).toHaveLength(2);
    const loose = inputs.find((input) => !input.hasAttribute('webkitdirectory'));
    const folder = inputs.find((input) => input.hasAttribute('webkitdirectory'));
    expect(loose).toBeDefined();
    expect(loose).toHaveAttribute('multiple');
    expect(loose).not.toHaveAttribute('accept');
    expect(folder).toBeDefined();
    expect(folder).toHaveAttribute('webkitdirectory');
  });

  it('closes the menu before opening the native picker', async () => {
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    const click = vi.spyOn(loose, 'click').mockImplementation(() => {});
    const trigger = screen.getByRole('button', { name: 'Add attachment' });
    fireEvent.click(trigger);

    fireEvent.click(await screen.findByText('Select files'));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('does nothing on picker cancellation and clears the value after every selection', async () => {
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;

    fireEvent.change(loose, { target: { files: [] } });
    expect(mocks.upload).not.toHaveBeenCalled();

    const pdf = new File(['pdf'], 'paper.pdf', { type: 'application/pdf' });
    fireEvent.change(loose, { target: { files: [pdf] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(1));
    expect(loose.value).toBe('');

    fireEvent.change(loose, { target: { files: [pdf] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    expect(loose.value).toBe('');
  });

  it('routes a mixed PNG/PDF/CSV/BIN selection through the shared ingestion pipeline', async () => {
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    const files = [
      sizedFile('figure.png', 'image/png'),
      sizedFile('paper.pdf', 'application/pdf'),
      sizedFile('data.csv', 'text/csv'),
      sizedFile('unknown.bin', 'application/octet-stream'),
    ];

    fireEvent.change(loose, { target: { files } });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(4));
    expect(mocks.upload.mock.calls.map((call) => [call[0].name, call[1]])).toEqual([
      ['figure.png', 'sources/chat/images'],
      ['paper.pdf', 'sources/chat'],
      ['data.csv', 'sources/chat'],
      ['unknown.bin', 'sources/chat'],
    ]);
    await waitFor(() => {
      for (const name of files.map((file) => file.name)) expect(screen.getByText(name)).toBeInTheDocument();
      expect(document.querySelectorAll('.chat-attachment-thumb img')).toHaveLength(1);
    });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps a 6MB image as a workspace reference without creating an inline thumbnail', async () => {
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    const largeImage = sizedFile('large.png', 'image/png', 6 * 1024 * 1024);

    fireEvent.change(loose, { target: { files: [largeImage] } });

    await waitFor(() => expect(screen.getByText('large.png')).toBeInTheDocument());
    expect(mocks.upload).toHaveBeenCalledWith(largeImage, 'sources/chat/images', expect.any(String));
    expect(document.querySelector('.chat-attachment-thumb img')).toBeNull();
  });

  it('preserves a selected folder hierarchy and renders one top-level folder chip', async () => {
    const { container } = renderComposer();
    const folder = fileInputs(container).find((input) => input.hasAttribute('webkitdirectory'))!;
    const files = [
      folderFile('图1.png', 'image/png', '研究资料/子目录/图1.png'),
      folderFile('论文.pdf', 'application/pdf', '研究资料/子目录/论文.pdf'),
    ];

    fireEvent.change(folder, { target: { files } });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('研究资料/')).toHaveLength(1);
    expect(document.querySelector('.chat-attachment-thumb img')).toBeNull();
    expect(mocks.upload.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [expect.stringMatching(/^sources\/chat\/\d+-研究资料\/子目录$/), '图1.png'],
      [expect.stringMatching(/^sources\/chat\/\d+-研究资料\/子目录$/), '论文.pdf'],
    ]);
  });

  it('blocks send while an upload is pending, then sends the ready reference and clears the composer', async () => {
    let releaseUpload!: (value: unknown) => void;
    mocks.upload.mockImplementationOnce(() => new Promise((resolve) => { releaseUpload = resolve; }));
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    const pdf = sizedFile('pending.pdf', 'application/pdf');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Review this' } });

    fireEvent.change(loose, { target: { files: [pdf] } });
    await waitFor(() => expect(screen.getByText('pending.pdf')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();

    releaseUpload({
      name: 'pending.pdf', path: 'sources/chat/qa-pending.pdf', size: pdf.size,
      mime_type: pdf.type, type: 'file', modified_at: '', git_status: '',
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    await waitFor(() => expect(gatewayRequest).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      message: expect.stringContaining('- @sources/chat/qa-pending.pdf'),
    })));
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByText('pending.pdf')).not.toBeInTheDocument();
  });

  it('supports loose-file error → retry → ready without reselecting', async () => {
    mocks.upload
      .mockRejectedValueOnce(new Error('network down'))
      .mockImplementationOnce(async (file: File, destination: string, fileName: string) => ({
        name: fileName, path: `${destination}/${fileName}`, size: file.size,
        mime_type: file.type, type: 'file', modified_at: '', git_status: '',
      }));
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    fireEvent.change(loose, { target: { files: [sizedFile('retry.pdf', 'application/pdf')] } });

    const retry = await screen.findByText('Retry');
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByText('Retry')).not.toBeInTheDocument());
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    expect(screen.getByText('retry.pdf').closest('.chat-reference-chip')).toHaveClass('is-ready');
  });

  it('keeps folder partial/all-failure state semantics', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container, unmount } = renderComposer();
    const folder = fileInputs(container).find((input) => input.hasAttribute('webkitdirectory'))!;
    mocks.upload.mockResolvedValueOnce({ path: 'sources/chat/root/a.txt', size: 1, mime_type: 'text/plain' });
    mocks.upload.mockRejectedValueOnce(new Error('one failed'));
    fireEvent.change(folder, { target: { files: [
      folderFile('a.txt', 'text/plain', 'partial/a.txt'),
      folderFile('b.txt', 'text/plain', 'partial/b.txt'),
    ] } });
    await waitFor(() => expect(screen.getByText('partial/').closest('.chat-reference-chip')).toHaveClass('is-ready'));
    expect(mocks.warning).toHaveBeenCalled();

    unmount();
    cleanup();
    mocks.upload.mockReset();
    mocks.upload.mockRejectedValue(new Error('all failed'));
    const second = renderComposer();
    const secondFolder = fileInputs(second.container).find((input) => input.hasAttribute('webkitdirectory'))!;
    fireEvent.change(secondFolder, { target: { files: [folderFile('x.txt', 'text/plain', 'failed/x.txt')] } });
    await waitFor(() => expect(screen.getByText('failed/').closest('.chat-reference-chip')).toHaveClass('is-error'));
    consoleError.mockRestore();
  });

  it('links image thumbnail and reference deletion in both directions', async () => {
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    const image = sizedFile('linked.png', 'image/png');
    fireEvent.change(loose, { target: { files: [image] } });
    await waitFor(() => expect(document.querySelector('.chat-attachment-thumb img')).not.toBeNull());

    fireEvent.click(document.querySelector<HTMLButtonElement>('.chat-attachment-remove')!);
    expect(screen.queryByText('linked.png')).not.toBeInTheDocument();
    expect(document.querySelector('.chat-attachment-thumb img')).toBeNull();

    fireEvent.change(loose, { target: { files: [image] } });
    await waitFor(() => expect(document.querySelector('.chat-attachment-thumb img')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
    expect(screen.queryByText('linked.png')).not.toBeInTheDocument();
    expect(document.querySelector('.chat-attachment-thumb img')).toBeNull();
  });

  it('does not resurrect a thumbnail when its reference is removed before FileReader finishes', async () => {
    const readers: Array<{
      result: string;
      onload: ((event: ProgressEvent<FileReader>) => void) | null;
    }> = [];
    class DeferredFileReader {
      result = 'data:image/png;base64,YQ==';
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      constructor() {
        readers.push(this);
      }
      readAsDataURL() {}
    }
    vi.stubGlobal('FileReader', DeferredFileReader);

    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    fireEvent.change(loose, { target: { files: [sizedFile('late.png', 'image/png')] } });

    await waitFor(() => expect(screen.getByText('late.png').closest('.chat-reference-chip')).toHaveClass('is-ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove reference' }));
    expect(screen.queryByText('late.png')).not.toBeInTheDocument();

    act(() => readers[0].onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>));
    expect(document.querySelector('.chat-attachment-thumb img')).toBeNull();
  });

  it('shows the soft no-vision hint only when an inline image is present', async () => {
    mocks.vision.supportsImage = false;
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;

    fireEvent.change(loose, { target: { files: [sizedFile('document.pdf', 'application/pdf')] } });
    await waitFor(() => expect(screen.getByText('document.pdf')).toBeInTheDocument());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    fireEvent.change(loose, { target: { files: [sizedFile('vision.png', 'image/png')] } });
    expect(await screen.findByRole('status')).toHaveTextContent('Image attached');
  });

  it('never puts non-images in chat.send.attachments and reuses image wsPath without rc.ws.saveImage', async () => {
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    fireEvent.change(loose, { target: { files: [
      sizedFile('inline.png', 'image/png'),
      sizedFile('only-reference.pdf', 'application/pdf'),
    ] } });
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(document.querySelector('.chat-attachment-thumb img')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    await waitFor(() => expect(gatewayRequest.mock.calls.some((call) => call[0] === 'chat.send')).toBe(true));
    expect(gatewayRequest.mock.calls.some((call) => call[0] === 'rc.ws.saveImage')).toBe(false);
    const sendCall = gatewayRequest.mock.calls.find((call) => call[0] === 'chat.send')!;
    const params = sendCall[1] as { attachments: Array<{ type: string; mimeType: string }>; message: string };
    expect(params.attachments).toHaveLength(1);
    expect(params.attachments[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(params.message).toContain('only-reference.pdf');
    expect(document.querySelector('.chat-attachment-thumb img')).toBeNull();
    expect(document.querySelector('.chat-reference-chip')).toBeNull();
  });

  it('keeps IME text/selection stable while the attachment menu opens and ignores Enter during composition', async () => {
    renderComposer();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '中文输入' } });
    textarea.setSelectionRange(2, 2);
    fireEvent.compositionStart(textarea);

    fireEvent.click(screen.getByRole('button', { name: 'Add attachment' }));
    expect(await screen.findByText('Select files')).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(textarea.value).toBe('中文输入');
    expect(textarea.selectionStart).toBe(2);
    expect(gatewayRequest.mock.calls.some((call) => call[0] === 'chat.send')).toBe(false);
  });

  it('restores document reference chips from the abort snapshot', async () => {
    renderComposer();

    act(() => {
      useChatStore.setState({
        inputRestore: {
          text: 'Review again',
          attachments: [],
          references: ['sources/chat/paper.pdf', 'sources/chat/data.csv'],
        },
        inputRestoreSeq: 1,
      });
    });

    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Review again'));
    expect(screen.getByText('paper.pdf')).toBeInTheDocument();
    expect(screen.getByText('data.csv')).toBeInTheDocument();
  });

  it('keeps external drop, workspace-path drop, image paste, and plain-text paste behavior', async () => {
    const { container } = renderComposer();
    const composer = container.querySelector('.chat-composer')!;
    const dropped = sizedFile('dropped.pdf', 'application/pdf');
    fireEvent.drop(composer, {
      dataTransfer: {
        types: ['Files'],
        items: [],
        files: [dropped],
        getData: vi.fn(),
      },
    });
    await waitFor(() => expect(screen.getByText('dropped.pdf')).toBeInTheDocument());

    fireEvent.drop(composer, {
      dataTransfer: {
        types: ['text/x-workspace-path'],
        items: [],
        files: [],
        getData: () => 'sources/existing.csv',
      },
    });
    expect(await screen.findByText('existing.csv')).toBeInTheDocument();

    const textarea = screen.getByRole('textbox');
    const beforePasteUploads = mocks.upload.mock.calls.length;
    fireEvent.paste(textarea, {
      clipboardData: { items: [{ type: 'text/plain', getAsFile: () => null }] },
    });
    expect(mocks.upload).toHaveBeenCalledTimes(beforePasteUploads);

    const pasted = sizedFile('pasted.png', 'image/png');
    fireEvent.paste(textarea, {
      clipboardData: { items: [{ type: 'image/png', getAsFile: () => pasted }] },
    });
    await waitFor(() => expect(screen.getByText('pasted.png')).toBeInTheDocument());
  });

  it('keeps the @ workspace-reference picker wired to the existing reference path', async () => {
    gatewayRequest.mockImplementation(async (method: string) => {
      if (method === 'rc.ws.tree') {
        return {
          tree: [{
            path: 'sources', type: 'directory', children: [
              { path: 'sources/paper.pdf', type: 'file' },
            ],
          }],
        };
      }
      return {};
    });
    renderComposer();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@pap' } });
    textarea.setSelectionRange(4, 4);
    fireEvent.select(textarea);

    const option = await screen.findByRole('option');
    expect(option).toHaveTextContent('@paper.pdf');
    fireEvent.mouseDown(option);

    expect(await screen.findByText('paper.pdf')).toBeInTheDocument();
    expect(textarea.value).toBe('');
  });

  it('limits loose multi-file uploads to the shared concurrency ceiling', async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    mocks.upload.mockImplementation((file: File, destination: string, fileName: string) => {
      active += 1;
      peak = Math.max(peak, active);
      return new Promise((resolve) => {
        releases.push(() => {
          active -= 1;
          resolve({ path: `${destination}/${fileName}`, size: file.size, mime_type: file.type });
        });
      });
    });
    const { container } = renderComposer();
    const loose = fileInputs(container).find((input) => !input.hasAttribute('webkitdirectory'))!;
    fireEvent.change(loose, { target: { files: Array.from({ length: 12 }, (_, index) => sizedFile(`f${index}.bin`, 'application/octet-stream')) } });

    await waitFor(() => expect(mocks.upload).toHaveBeenCalledTimes(5));
    while (mocks.upload.mock.calls.length < 12 || releases.length > 0) {
      const release = releases.shift();
      if (release) {
        await act(async () => {
          release();
          await Promise.resolve();
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    expect(peak).toBeLessThanOrEqual(5);
  });
});
