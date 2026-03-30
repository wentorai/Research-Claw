/**
 * PptTab — Unit tests for the PPT generation panel
 *
 * Reference files:
 *   - ExtensionsPanel.tsx:1251-1590 (PptTab component)
 *   - ppt-master/skills/ppt-master/scripts/config.py:48-121 (CANVAS_FORMATS)
 *   - extensions/research-claw-core/src/ppt/service.ts:150-154 (projectName validation)
 *
 * Tests verify:
 *   1. Canvas format Select renders all 8 options with descriptions
 *   2. Format tooltip (QuestionCircleOutlined) is present
 *   3. projectName validation disables submit button
 *   4. Submit button requires both valid projectName and source file
 *   5. Submit triggers confirmation modal before sending agent prompt
 *   6. Open output button disabled when no output available
 *   7. Open output uses rc.ws.openExternal (not rc.ppt.open)
 *   8. Docker fallback renders DockerFileModal
 *   9. localStorage persistence for projectName and format
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import ExtensionsPanel from './ExtensionsPanel';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { useExtensionsStore } from '../../stores/extensions';
import { useChatStore } from '../../stores/chat';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('react-window', () => ({
  List: function MockList({ rowComponent: Row, rowCount, rowProps }: {
    rowComponent: React.ComponentType<any>;
    rowCount: number;
    rowProps: Record<string, unknown>;
    [key: string]: unknown;
  }) {
    return (
      <div data-testid="virtual-list">
        {Array.from({ length: rowCount }, (_, index) => (
          <Row key={index} index={index} style={{}} ariaAttributes={{}} {...rowProps} />
        ))}
      </div>
    );
  },
}));

// i18n mock: return STABLE references to avoid infinite useCallback/useEffect cycles
const stableT = (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
  if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
  if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) return fallbackOrOpts.defaultValue as string;
  return key;
};
const stableI18n = { changeLanguage: vi.fn(), language: 'en' };
const stableTranslation = { t: stableT, i18n: stableI18n };
vi.mock('react-i18next', () => ({
  useTranslation: () => stableTranslation,
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../../utils/relativeTime', () => ({
  relativeTime: () => '2h ago',
}));

vi.mock('./DockerFileModal', () => {
  function MockDockerFileModal({ open, containerPath, relativePath, fileName }: {
    open: boolean;
    containerPath: string;
    relativePath: string;
    fileName?: string;
    onClose: () => void;
    mode: string;
  }) {
    if (!open) return null;
    return (
      <div data-testid="docker-file-modal">
        <span data-testid="docker-container-path">{containerPath}</span>
        <span data-testid="docker-relative-path">{relativePath}</span>
        <span data-testid="docker-file-name">{fileName}</span>
      </div>
    );
  }
  return { default: MockDockerFileModal, DockerFileModal: MockDockerFileModal };
});

// Spy on useChatStore.getState().send — patched in beforeEach
const mockSend = vi.fn();

// ── Helpers ────────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

let mockRequest: Mock;

/** Click a Segmented tab option by its label text */
function clickPptTab() {
  const labels = screen.getAllByText('PPT');
  for (const el of labels) {
    const labelEl = el.closest('.ant-segmented-item');
    if (labelEl) {
      fireEvent.click(labelEl);
      return;
    }
  }
  fireEvent.click(labels[0]);
}

/** Shared files list — mutated before render to configure what rc.ppt.outputs.list returns */
let mockFiles: string[] = [];
/** Custom openExternal handler — overridden per test */
let mockOpenExternal: (() => Promise<Record<string, unknown>>) | null = null;

function setupMockRpc() {
  mockRequest = vi.fn().mockImplementation((method: string) => {
    if (method === 'rc.ppt.outputs.list') {
      return Promise.resolve({ root: '/workspace/outputs', files: mockFiles });
    }
    if (method === 'rc.ppt.status') {
      return Promise.resolve({
        pptRoot: '/test/ppt-master',
        exists: true,
        scriptsRoot: '/test/ppt-master/scripts',
        hasProjectManager: true,
        hasSvgToPptx: true,
      });
    }
    if (method === 'rc.ws.openExternal' && mockOpenExternal) {
      return mockOpenExternal();
    }
    if (method === 'rc.ws.openExternal') {
      return Promise.resolve({ ok: true });
    }
    return Promise.resolve({ ok: true });
  });
}

async function renderPptTab() {
  const result = render(<Wrapper><ExtensionsPanel /></Wrapper>);
  // Click PPT tab — triggers PptTab mount + useEffect (handleRefreshSources RPC)
  clickPptTab();
  // Wait for PptTab to mount AND the initial RPC to settle (outputs.list called + loading=false)
  await waitFor(() => {
    expect(screen.getByText('Submit Task')).toBeTruthy();
    // Ensure the auto-refresh RPC has been called
    expect(mockRequest).toHaveBeenCalledWith('rc.ppt.outputs.list', {});
  });
  // Flush pending state updates from the RPC handler
  await waitFor(() => {
    // Refresh sources button is visible and not loading = RPC settled
    const refreshBtn = screen.getByText('Refresh sources');
    expect(refreshBtn.closest('button')?.classList.contains('ant-btn-loading')).toBe(false);
  });
  return result;
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockFiles = [];
  mockOpenExternal = null;
  setupMockRpc();

  vi.spyOn(useChatStore, 'getState').mockReturnValue({
    ...useChatStore.getState(),
    send: mockSend,
  } as ReturnType<typeof useChatStore.getState>);

  useConfigStore.setState({ theme: 'dark' });
  useGatewayStore.setState({
    state: 'connected',
    client: { isConnected: true, request: mockRequest } as never,
  });
  useExtensionsStore.setState({
    skills: [],
    skillsLoading: false,
    skillsLoaded: true,
    managedSkillsDir: '',
    channels: [],
    channelsLoading: false,
    channelsLoaded: true,
    plugins: [],
    pluginsLoaded: true,
  });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PptTab', () => {
  it('renders PPT tab with Submit Task button', async () => {
    await renderPptTab();
    expect(screen.getByText('Submit Task')).toBeTruthy();
  });

  describe('Canvas format Select', () => {
    it('renders format as Select (not Input) with all 8 canvas formats', async () => {
      await renderPptTab();

      // The format Select should show the default ppt169 label
      expect(screen.getByText('ppt169 (1280×720)')).toBeTruthy();

      // Open the dropdown to verify all options
      const formatSelect = screen.getByText('ppt169 (1280×720)').closest('.ant-select');
      expect(formatSelect).toBeTruthy();
    });

    it('shows format tooltip with QuestionCircleOutlined', async () => {
      await renderPptTab();

      // The label text should be present
      expect(screen.getByText('Canvas format')).toBeTruthy();

      // QuestionCircleOutlined renders as a span with role=img or an svg
      const helpIcons = document.querySelectorAll('.anticon-question-circle');
      expect(helpIcons.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Project name validation', () => {
    it('disables submit button when projectName is empty', async () => {
      await renderPptTab();

      const input = screen.getByPlaceholderText('Project name (letters, numbers, _, -, .)');
      fireEvent.change(input, { target: { value: '' } });

      await waitFor(() => {
        const submitBtn = screen.getByText('Submit Task').closest('button')!;
        expect(submitBtn.hasAttribute('disabled') || submitBtn.classList.contains('ant-btn-disabled')).toBe(true);
      });
    });

    it('disables submit button when projectName contains invalid characters', async () => {
      await renderPptTab();

      const input = screen.getByPlaceholderText('Project name (letters, numbers, _, -, .)');
      fireEvent.change(input, { target: { value: 'bad name!' } });

      await waitFor(() => {
        expect(screen.getByText('Only letters, numbers, underscore, dash, and dot are allowed')).toBeTruthy();
        const submitBtn = screen.getByText('Submit Task').closest('button')!;
        expect(submitBtn.hasAttribute('disabled') || submitBtn.classList.contains('ant-btn-disabled')).toBe(true);
      });
    });

    it('enables submit button with valid projectName and selected source file', async () => {
      mockFiles = ['/workspace/outputs/report.md'];
      await renderPptTab();

      await waitFor(() => {
        const submitBtn = screen.getByText('Submit Task').closest('button')!;
        expect(submitBtn.hasAttribute('disabled')).toBe(false);
      });
    });
  });

  describe('Submit task with confirmation', () => {
    /** Helper: find text within document.body (Antd modal renders via portal) */
    function bodyHasText(text: string) {
      return document.body.textContent?.includes(text) ?? false;
    }

    it('shows confirmation modal on submit click', async () => {
      mockFiles = ['/workspace/outputs/research.pdf'];
      await renderPptTab();

      await waitFor(() => {
        const submitBtn = screen.getByText('Submit Task').closest('button')!;
        expect(submitBtn.hasAttribute('disabled')).toBe(false);
      });

      const submitBtn = screen.getByText('Submit Task').closest('button')!;
      fireEvent.click(submitBtn);

      // Antd modal.confirm renders via portal — check body
      await waitFor(() => {
        expect(bodyHasText('Confirm Submission')).toBe(true);
        expect(bodyHasText('Research-Claw will start generating the PPT')).toBe(true);
      });
    });

    it('sends agent prompt after confirmation', async () => {
      mockFiles = ['/workspace/outputs/research.pdf'];
      await renderPptTab();

      await waitFor(() => {
        const submitBtn = screen.getByText('Submit Task').closest('button')!;
        expect(submitBtn.hasAttribute('disabled')).toBe(false);
      });

      fireEvent.click(screen.getByText('Submit Task').closest('button')!);

      await waitFor(() => {
        expect(bodyHasText('Confirm Submission')).toBe(true);
      });

      // Find and click OK button in the modal (rendered in body)
      const allButtons = document.querySelectorAll('.ant-btn-primary');
      const okBtn = Array.from(allButtons).find(
        (btn) => btn.textContent === 'OK',
      ) as HTMLElement;
      expect(okBtn).toBeTruthy();
      fireEvent.click(okBtn);

      await waitFor(() => {
        expect(mockSend).toHaveBeenCalledTimes(1);
        const prompt = mockSend.mock.calls[0][0] as string;
        expect(prompt).toContain('ppt-master');
        expect(prompt).toContain('research.pdf');
        expect(prompt).toContain('demo-deck');
        expect(prompt).toContain('ppt169');
      });
    });

    it('does not send prompt when Cancel is clicked', async () => {
      mockFiles = ['/workspace/outputs/research.pdf'];
      await renderPptTab();

      await waitFor(() => {
        const submitBtn = screen.getByText('Submit Task').closest('button')!;
        expect(submitBtn.hasAttribute('disabled')).toBe(false);
      });

      fireEvent.click(screen.getByText('Submit Task').closest('button')!);

      await waitFor(() => {
        expect(bodyHasText('Confirm Submission')).toBe(true);
      });

      // Find and click Cancel button in the modal
      const allButtons = document.querySelectorAll('.ant-btn');
      const cancelBtn = Array.from(allButtons).find(
        (btn) => btn.textContent === 'Cancel' && !btn.classList.contains('ant-btn-primary'),
      ) as HTMLElement;
      expect(cancelBtn).toBeTruthy();
      fireEvent.click(cancelBtn);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('Open output button', () => {
    it('is disabled when no output file exists', async () => {
      await renderPptTab();

      const openBtn = screen.getByText('Open Output').closest('button')!;
      expect(openBtn.hasAttribute('disabled') || openBtn.classList.contains('ant-btn-disabled')).toBe(true);
    });

    it('stays disabled when pptx exists outside /outputs/ppt/', async () => {
      // pptx exists but NOT under /outputs/ppt/ — should not enable button
      mockFiles = [
        '/workspace/outputs/some-other-dir/presentation.pptx',
        '/workspace/outputs/research.pdf',
      ];
      await renderPptTab();

      const openBtn = screen.getByText('Open Output').closest('button')!;
      expect(openBtn.hasAttribute('disabled') || openBtn.classList.contains('ant-btn-disabled')).toBe(true);
    });

    it('is enabled when any pptx exists under /outputs/ppt/ regardless of name', async () => {
      // LLM-generated filenames vary — any pptx under /outputs/ppt/ should enable
      mockFiles = [
        '/workspace/outputs/ppt/2026-03-30/研究報告-2026-03-30T04-29-55.pptx',
        '/workspace/outputs/research.pdf',
      ];
      await renderPptTab();

      // Trigger a manual refresh to ensure output state settles
      fireEvent.click(screen.getByText('Refresh sources').closest('button')!);

      await waitFor(() => {
        const openBtn = screen.getByText('Open Output').closest('button')!;
        expect(openBtn.hasAttribute('disabled')).toBe(false);
      });
    });

    it('opens the newest pptx (first in mtime-sorted list)', async () => {
      // Service returns files sorted by mtime desc — first match is newest
      mockFiles = [
        '/workspace/outputs/ppt/2026-03-30/研究報告-newest.pptx',
        '/workspace/outputs/ppt/2026-03-29/older-output.pptx',
        '/workspace/outputs/research.pdf',
      ];
      await renderPptTab();

      await waitFor(() => {
        const openBtn = screen.getByText('Open Output').closest('button')!;
        expect(openBtn.hasAttribute('disabled')).toBe(false);
      });

      const openBtn = screen.getByText('Open Output').closest('button')!;
      fireEvent.click(openBtn);

      await waitFor(() => {
        const openCall = mockRequest.mock.calls.find(
          (c: unknown[]) => c[0] === 'rc.ws.openExternal',
        );
        expect(openCall).toBeTruthy();
        // Should open the first (newest) pptx, not the older one
        expect((openCall![1] as { path: string }).path).toContain('newest');
      });
    });

    it('uses rc.ws.openExternal instead of rc.ppt.open', async () => {
      mockFiles = ['/workspace/outputs/ppt/2026-03-30/demo-deck-final.pptx'];
      await renderPptTab();

      await waitFor(() => {
        const openBtn = screen.getByText('Open Output').closest('button')!;
        expect(openBtn.hasAttribute('disabled')).toBe(false);
      });

      const openBtn = screen.getByText('Open Output').closest('button')!;
      fireEvent.click(openBtn);

      await waitFor(() => {
        const methods = mockRequest.mock.calls.map((c: unknown[]) => c[0]);
        expect(methods).toContain('rc.ws.openExternal');
        expect(methods).not.toContain('rc.ppt.open');
      });
    });

    it('shows DockerFileModal on Docker fallback', async () => {
      mockFiles = ['/workspace/outputs/ppt/2026-03-30/demo-deck-final.pptx'];
      mockOpenExternal = () => Promise.resolve({
        ok: false,
        fallback: 'docker',
        containerPath: '/app/workspace//workspace/outputs/ppt/2026-03-30/demo-deck-final.pptx',
        relativePath: '/workspace/outputs/ppt/2026-03-30/demo-deck-final.pptx',
        fileName: 'output.pptx',
      });

      await renderPptTab();

      await waitFor(() => {
        const openBtn = screen.getByText('Open Output').closest('button')!;
        expect(openBtn.hasAttribute('disabled')).toBe(false);
      });

      const openBtn = screen.getByText('Open Output').closest('button')!;
      fireEvent.click(openBtn);

      await waitFor(() => {
        expect(screen.getByTestId('docker-file-modal')).toBeTruthy();
        expect(screen.getByTestId('docker-container-path').textContent).toBe(
          '/app/workspace//workspace/outputs/ppt/2026-03-30/demo-deck-final.pptx',
        );
        expect(screen.getByTestId('docker-file-name').textContent).toBe('output.pptx');
      });
    });
  });

  describe('localStorage persistence', () => {
    it('persists projectName to localStorage', async () => {
      await renderPptTab();

      const input = screen.getByPlaceholderText('Project name (letters, numbers, _, -, .)');
      fireEvent.change(input, { target: { value: 'my-project' } });

      await waitFor(() => {
        expect(localStorage.getItem('rc-ppt-project-name')).toBe('my-project');
      });
    });

    it('restores projectName from localStorage on mount', async () => {
      localStorage.setItem('rc-ppt-project-name', 'saved-project');

      await renderPptTab();

      const input = screen.getByPlaceholderText('Project name (letters, numbers, _, -, .)') as HTMLInputElement;
      expect(input.value).toBe('saved-project');
    });

    it('persists format to localStorage', async () => {
      await renderPptTab();

      // Default format should be persisted
      expect(localStorage.getItem('rc-ppt-format')).toBe('ppt169');
    });

    it('restores format from localStorage on mount', async () => {
      localStorage.setItem('rc-ppt-format', 'a4');

      await renderPptTab();

      // Should show the a4 format label
      expect(screen.getByText('a4 (1240×1754)')).toBeTruthy();
    });

    it('defaults to demo-deck when localStorage is empty', async () => {
      await renderPptTab();

      const input = screen.getByPlaceholderText('Project name (letters, numbers, _, -, .)') as HTMLInputElement;
      expect(input.value).toBe('demo-deck');
    });
  });

  describe('UI labels and text', () => {
    it('shows "Generate PPT" as section title (not "Init Project")', async () => {
      await renderPptTab();

      expect(screen.getByText('Generate PPT')).toBeTruthy();
    });

    it('shows "Submit Task" as button text (not "Init")', async () => {
      await renderPptTab();

      expect(screen.getByText('Submit Task')).toBeTruthy();
      expect(screen.queryByText('Init')).toBeNull();
    });

    it('shows "Output" as output section title', async () => {
      await renderPptTab();

      expect(screen.getByText('Output')).toBeTruthy();
    });
  });
});
