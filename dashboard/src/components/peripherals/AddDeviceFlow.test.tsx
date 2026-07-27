import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConfigProvider, App as AntdApp } from 'antd';
import { useGatewayStore } from '../../stores/gateway';
import { useConfigStore } from '../../stores/config';
import { usePeripheralsStore, type PeriphDeviceRow } from '../../stores/peripherals';

// PlaudCard (rendered in the Plaud pane) touches config/peripheral stores at mount;
// stub it so this test focuses on the AddDeviceFlow source-picker + camera add.
vi.mock('./PlaudCard', () => ({
  default: () => <div data-testid="plaud-card-stub">plaud card</div>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: string | Record<string, unknown>) => {
      if (typeof fallbackOrOpts === 'string') return fallbackOrOpts;
      if (fallbackOrOpts && 'defaultValue' in fallbackOrOpts) return fallbackOrOpts.defaultValue as string;
      return key;
    },
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import AddDeviceFlow, { type BrowserCameraOption } from './AddDeviceFlow';

function makeDevice(overrides: Partial<PeriphDeviceRow> = {}): PeriphDeviceRow {
  return {
    id: 'dev-new', name: 'x', kind: 'camera', driver: 'browser-camera', enabled: true,
    config: { deviceId: 'cam-b' }, check_prompt: '', last_seen_at: null, last_error: null,
    created_at: '', updated_at: '', ...overrides,
  };
}

const CAMS: BrowserCameraOption[] = [
  { deviceId: 'cam-a', label: 'FaceTime HD Camera' },
  { deviceId: 'cam-b', label: 'USB Webcam' },
];

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider>
      <AntdApp>{children}</AntdApp>
    </ConfigProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  useConfigStore.setState({ theme: 'dark' });
  useGatewayStore.setState({ state: 'connected', client: { isConnected: true, request: vi.fn().mockResolvedValue({}) } as never });
  usePeripheralsStore.setState({
    devices: [], observations: {}, observationsHasMore: {}, loading: false, error: null, unavailable: false,
  });
});

function renderFlow(props: Partial<React.ComponentProps<typeof AddDeviceFlow>> = {}) {
  return render(
    <Wrapper>
      <AddDeviceFlow
        open
        onClose={vi.fn()}
        browserCameras={CAMS}
        onRefreshCameras={vi.fn()}
        cameraUsable
        needsAuth={false}
        onAuthorize={vi.fn()}
        {...props}
      />
    </Wrapper>,
  );
}

// ── Source picker (§14.3) ─────────────────────────────────────────────────────
describe('AddDeviceFlow (§14.3)', () => {
  it('renders three sources; browser-camera lists present cameras with a name input', () => {
    renderFlow();
    expect(screen.getByTestId('periph-add-source-camera')).toBeTruthy();
    expect(screen.getByTestId('periph-add-source-plaud')).toBeTruthy();
    expect(screen.getByTestId('periph-add-source-rtsp')).toBeTruthy();
    expect(screen.getByTestId('periph-add-camera-row-cam-a')).toBeTruthy();
    expect(screen.getByTestId('periph-add-camera-name-cam-b')).toBeTruthy();
  });

  it('add-as-device → createDevice(browser-camera) + announceBridge, toast copy', async () => {
    const createSpy = vi
      .spyOn(usePeripheralsStore.getState(), 'createDevice')
      .mockResolvedValue(makeDevice());
    const announceSpy = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();

    renderFlow();
    fireEvent.change(screen.getByTestId('periph-add-camera-name-cam-b'), { target: { value: 'USB Cam' } });
    fireEvent.click(screen.getByTestId('periph-add-camera-btn-cam-b'));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'USB Cam', kind: 'camera', driver: 'browser-camera', config: expect.objectContaining({ deviceId: 'cam-b' }) }),
      ),
    );
    expect(announceSpy).toHaveBeenCalledWith([{ deviceId: 'cam-b', label: 'USB Cam' }], expect.any(Boolean));
  });

  it('an already-registered camera shows "Added" instead of an add button', () => {
    usePeripheralsStore.setState({
      devices: [makeDevice({ id: 'dev-a', config: { deviceId: 'cam-a' } })],
    });
    renderFlow();
    expect(screen.getByTestId('periph-add-camera-already-cam-a')).toBeTruthy();
    expect(screen.queryByTestId('periph-add-camera-btn-cam-a')).toBeNull();
    // cam-b (not registered) still offers add.
    expect(screen.getByTestId('periph-add-camera-btn-cam-b')).toBeTruthy();
  });

  it('needsAuth shows an authorize button instead of the camera list', () => {
    renderFlow({ needsAuth: true });
    expect(screen.getByTestId('periph-add-camera-authorize-btn')).toBeTruthy();
    expect(screen.queryByTestId('periph-add-camera-row-cam-a')).toBeNull();
  });

  it('RTSP pane is active: URL + optional user/password → createDevice(rtsp)', async () => {
    const createSpy = vi
      .spyOn(usePeripheralsStore.getState(), 'createDevice')
      .mockResolvedValue(makeDevice({ driver: 'rtsp', config: { url: 'rtsp://cam.lan/s' } }));
    // announceBridge must NOT be called for an rtsp device (no browser bridge).
    const announceSpy = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();

    renderFlow();
    const rtspLabel = screen.getByTestId('periph-add-source-rtsp').closest('label');
    fireEvent.click(rtspLabel ?? screen.getByTestId('periph-add-source-rtsp'));

    // Form fields present (URL required + optional name/user/password).
    fireEvent.change(screen.getByTestId('periph-add-rtsp-name'), { target: { value: 'Incubator Cam' } });
    fireEvent.change(screen.getByTestId('periph-add-rtsp-url'), { target: { value: 'rtsp://cam.lan:554/stream' } });
    fireEvent.change(screen.getByTestId('periph-add-rtsp-username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByTestId('periph-add-rtsp-password'), { target: { value: 's3cr3t' } });

    fireEvent.click(screen.getByTestId('periph-add-rtsp-submit'));

    await waitFor(() =>
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Incubator Cam',
          kind: 'camera',
          driver: 'rtsp',
          config: expect.objectContaining({
            url: 'rtsp://cam.lan:554/stream',
            username: 'alice',
            password: 's3cr3t',
          }),
        }),
      ),
    );
    // rtsp devices are gateway-side; the browser bridge is never announced.
    expect(announceSpy).not.toHaveBeenCalled();
  });

  it('RTSP submit is blocked when the URL is empty', async () => {
    const createSpy = vi.spyOn(usePeripheralsStore.getState(), 'createDevice').mockResolvedValue(makeDevice());
    renderFlow();
    const rtspLabel = screen.getByTestId('periph-add-source-rtsp').closest('label');
    fireEvent.click(rtspLabel ?? screen.getByTestId('periph-add-source-rtsp'));
    // Submit with no URL.
    fireEvent.click(screen.getByTestId('periph-add-rtsp-submit'));
    // createDevice must not be called without a URL.
    await Promise.resolve();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('RTSP credentials are not put in the URL query string', async () => {
    const createSpy = vi
      .spyOn(usePeripheralsStore.getState(), 'createDevice')
      .mockResolvedValue(makeDevice({ driver: 'rtsp' }));
    renderFlow();
    const rtspLabel = screen.getByTestId('periph-add-source-rtsp').closest('label');
    fireEvent.click(rtspLabel ?? screen.getByTestId('periph-add-source-rtsp'));
    fireEvent.change(screen.getByTestId('periph-add-rtsp-url'), { target: { value: 'rtsp://cam.lan/stream' } });
    fireEvent.change(screen.getByTestId('periph-add-rtsp-password'), { target: { value: 'pw123' } });
    fireEvent.click(screen.getByTestId('periph-add-rtsp-submit'));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    const arg = createSpy.mock.calls[0][0];
    // URL stored verbatim (no ?password= injected); creds are separate config fields.
    expect((arg.config as { url: string }).url).toBe('rtsp://cam.lan/stream');
    expect((arg.config as { url: string }).url).not.toContain('pw123');
  });

  it('Plaud pane delegates to the existing PlaudCard connect flow', () => {
    renderFlow();
    const plaudLabel = screen.getByTestId('periph-add-source-plaud').closest('label');
    fireEvent.click(plaudLabel ?? screen.getByTestId('periph-add-source-plaud'));
    expect(screen.getByTestId('plaud-card-stub')).toBeTruthy();
  });

  // ── ④ Local camera (server-side) source (§15 v1.3 场景②) ────────────────────
  describe('local-camera source (§15 v1.3 场景②)', () => {
    function openLocalPane() {
      const localLabel = screen.getByTestId('periph-add-source-local').closest('label');
      fireEvent.click(localLabel ?? screen.getByTestId('periph-add-source-local'));
    }

    it('renders the local-camera source in the picker', () => {
      renderFlow();
      expect(screen.getByTestId('periph-add-source-local')).toBeTruthy();
    });

    it('enumerates OS cameras on mount → select + add → createDevice(local-camera), no announceBridge', async () => {
      const loadSpy = vi
        .spyOn(usePeripheralsStore.getState(), 'loadLocalCameras')
        .mockResolvedValue([
          { device: '0', label: 'FaceTime HD Camera' },
          { device: '1', label: 'USB Webcam' },
        ]);
      const createSpy = vi
        .spyOn(usePeripheralsStore.getState(), 'createDevice')
        .mockResolvedValue(makeDevice({ driver: 'local-camera', config: { device: '0' } }));
      const announceSpy = vi.spyOn(usePeripheralsStore.getState(), 'announceBridge').mockResolvedValue();

      renderFlow();
      openLocalPane();

      // Enumeration runs and the select appears (first camera pre-selected).
      await waitFor(() => expect(loadSpy).toHaveBeenCalled());
      await waitFor(() => expect(screen.getByTestId('periph-add-local-select')).toBeTruthy());

      fireEvent.change(screen.getByTestId('periph-add-local-name'), { target: { value: 'Bench Cam' } });
      fireEvent.click(screen.getByTestId('periph-add-local-submit'));

      await waitFor(() =>
        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Bench Cam',
            kind: 'camera',
            driver: 'local-camera',
            config: expect.objectContaining({ device: '0' }),
          }),
        ),
      );
      // local-camera is gateway-side; the browser bridge is never announced.
      expect(announceSpy).not.toHaveBeenCalled();
    });

    it('empty enumeration → manual device-index input, add uses the typed index', async () => {
      const loadSpy = vi
        .spyOn(usePeripheralsStore.getState(), 'loadLocalCameras')
        .mockResolvedValue([]);
      const createSpy = vi
        .spyOn(usePeripheralsStore.getState(), 'createDevice')
        .mockResolvedValue(makeDevice({ driver: 'local-camera', config: { device: '2' } }));

      renderFlow();
      openLocalPane();

      await waitFor(() => expect(loadSpy).toHaveBeenCalled());
      // Degrades to the manual input (no select) with an empty-state hint.
      await waitFor(() => expect(screen.getByTestId('periph-add-local-device-manual')).toBeTruthy());
      expect(screen.getByTestId('periph-add-local-empty')).toBeTruthy();
      expect(screen.queryByTestId('periph-add-local-select')).toBeNull();

      fireEvent.change(screen.getByTestId('periph-add-local-device-manual'), { target: { value: '2' } });
      fireEvent.click(screen.getByTestId('periph-add-local-submit'));

      await waitFor(() =>
        expect(createSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            driver: 'local-camera',
            config: expect.objectContaining({ device: '2' }),
          }),
        ),
      );
    });

    it('submit is disabled until a device is chosen/typed', async () => {
      vi.spyOn(usePeripheralsStore.getState(), 'loadLocalCameras').mockResolvedValue([]);
      const createSpy = vi.spyOn(usePeripheralsStore.getState(), 'createDevice').mockResolvedValue(makeDevice());

      renderFlow();
      openLocalPane();
      await waitFor(() => expect(screen.getByTestId('periph-add-local-device-manual')).toBeTruthy());

      // Click with no device entered — createDevice must not fire.
      fireEvent.click(screen.getByTestId('periph-add-local-submit'));
      await Promise.resolve();
      expect(createSpy).not.toHaveBeenCalled();
    });
  });
});
