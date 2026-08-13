/**
 * Config store unit tests.
 * Tests theme, locale, bootState, evaluateConfig (3-level fallback), and localStorage persistence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useConfigStore } from './config';

// Mock i18n
vi.mock('../i18n', () => ({
  default: {
    changeLanguage: vi.fn(),
  },
}));

// Mock gateway store — connState controlled via mockGatewayState
let mockGatewayState: { client: null; state: string } = { client: null, state: 'disconnected' };

vi.mock('./gateway', () => ({
  useGatewayStore: {
    getState: () => mockGatewayState,
  },
}));

describe('Config store', () => {
  beforeEach(() => {
    localStorage.clear();
    mockGatewayState = { client: null, state: 'disconnected' };
    useConfigStore.setState({
      theme: 'dark',
      locale: 'zh-CN',
      systemPromptAppend: '',
      bootState: 'pending',
      gatewayConfig: null,
      gatewayConfigLoading: false,
      _configRetryCount: 0,
      _configRequestGeneration: 0,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('setTheme', () => {
    it('updates state to light', () => {
      useConfigStore.getState().setTheme('light');
      expect(useConfigStore.getState().theme).toBe('light');
    });

    it('updates state to dark', () => {
      useConfigStore.getState().setTheme('light');
      useConfigStore.getState().setTheme('dark');
      expect(useConfigStore.getState().theme).toBe('dark');
    });

    it('persists to localStorage', () => {
      useConfigStore.getState().setTheme('light');
      expect(localStorage.getItem('rc-theme')).toBe('light');
    });

    it('sets data-theme attribute on documentElement', () => {
      useConfigStore.getState().setTheme('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  describe('setLocale', () => {
    it('updates state to zh-CN', () => {
      useConfigStore.getState().setLocale('zh-CN');
      expect(useConfigStore.getState().locale).toBe('zh-CN');
    });

    it('persists to localStorage', () => {
      useConfigStore.getState().setLocale('zh-CN');
      expect(localStorage.getItem('rc-locale')).toBe('zh-CN');
    });

    it('calls i18n.changeLanguage', async () => {
      const i18n = await import('../i18n');
      useConfigStore.getState().setLocale('zh-CN');
      expect(i18n.default.changeLanguage).toHaveBeenCalledWith('zh-CN');
    });
  });

  describe('setSystemPromptAppend', () => {
    it('updates state and persists', () => {
      useConfigStore.getState().setSystemPromptAppend('Be concise.');
      expect(useConfigStore.getState().systemPromptAppend).toBe('Be concise.');
      expect(localStorage.getItem('rc-system-prompt-append')).toBe('Be concise.');
    });
  });

  describe('evaluateConfig', () => {
    it('sets bootState to ready when config is valid (Level 1: strict)', () => {
      useConfigStore.setState({
        gatewayConfig: {
          agents: { defaults: { model: { primary: 'rc/gpt-4o' } } },
          models: {
            providers: {
              rc: { baseUrl: 'https://api.openai.com', models: [{ id: 'gpt-4o' }] },
            },
          },
        },
      });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('ready');
      expect(useConfigStore.getState()._configRetryCount).toBe(0);
    });

    it('sets bootState to ready when gateway connected + model exists but provider missing (Level 2: relaxed)', () => {
      mockGatewayState = { client: null, state: 'connected' };
      useConfigStore.setState({
        gatewayConfig: {
          agents: { defaults: { model: { primary: 'rc/glm-5' } } },
          models: { providers: {} },
        },
      });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('ready');
    });

    it('sets bootState to ready when gateway connected + model exists but no providers section (Level 2)', () => {
      mockGatewayState = { client: null, state: 'connected' };
      useConfigStore.setState({
        gatewayConfig: {
          agents: { defaults: { model: { primary: 'rc/google/gemini-3.1-pro-preview' } } },
        },
      });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('ready');
    });

    it('retries when gateway disconnected and config invalid (Level 3: retry)', () => {
      mockGatewayState = { client: null, state: 'disconnected' };
      useConfigStore.setState({
        gatewayConfig: {
          agents: { defaults: { model: { primary: 'rc/gpt-4o' } } },
          models: { providers: {} },
        },
        _configRetryCount: 0,
      });
      useConfigStore.getState().evaluateConfig();
      // Should increment retry count, not set needs_setup yet
      expect(useConfigStore.getState()._configRetryCount).toBe(1);
      expect(useConfigStore.getState().bootState).toBe('pending');
    });

    it('sets needs_setup after max retries exhausted', () => {
      mockGatewayState = { client: null, state: 'disconnected' };
      useConfigStore.setState({
        gatewayConfig: null,
        _configRetryCount: 5,
      });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('needs_setup');
      expect(useConfigStore.getState()._configRetryCount).toBe(0);
    });

    it('sets needs_setup when gatewayConfig is null and retries exhausted', () => {
      useConfigStore.setState({ gatewayConfig: null, _configRetryCount: 5 });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('needs_setup');
    });

    it('sets needs_setup when no model primary and retries exhausted', () => {
      mockGatewayState = { client: null, state: 'disconnected' };
      useConfigStore.setState({
        gatewayConfig: { agents: { defaults: {} }, models: { providers: {} } },
        _configRetryCount: 5,
      });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('needs_setup');
    });

    it('resets retry count on successful validation', () => {
      useConfigStore.setState({
        gatewayConfig: {
          agents: { defaults: { model: { primary: 'rc/gpt-4o' } } },
          models: { providers: { rc: { baseUrl: 'https://api.openai.com' } } },
        },
        _configRetryCount: 2,
      });
      useConfigStore.getState().evaluateConfig();
      expect(useConfigStore.getState().bootState).toBe('ready');
      expect(useConfigStore.getState()._configRetryCount).toBe(0);
    });
  });

  describe('setBootState', () => {
    it('sets bootState directly', () => {
      useConfigStore.getState().setBootState('gateway_unreachable');
      expect(useConfigStore.getState().bootState).toBe('gateway_unreachable');
    });
  });

  describe('loadConfig', () => {
    it('restores theme and locale from localStorage', () => {
      localStorage.setItem('rc-theme', 'light');
      localStorage.setItem('rc-locale', 'en');
      localStorage.setItem('rc-system-prompt-append', 'test prompt');

      useConfigStore.getState().loadConfig();

      const state = useConfigStore.getState();
      expect(state.theme).toBe('light');
      expect(state.locale).toBe('en');
      expect(state.systemPromptAppend).toBe('test prompt');
    });

    it('sets data-theme attribute when loading', () => {
      localStorage.setItem('rc-theme', 'light');
      useConfigStore.getState().loadConfig();
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });

    it('defaults to dark theme when localStorage is empty', () => {
      useConfigStore.getState().loadConfig();
      expect(useConfigStore.getState().theme).toBe('dark');
    });

    it('does not touch bootState', () => {
      useConfigStore.setState({ bootState: 'pending' });
      useConfigStore.getState().loadConfig();
      expect(useConfigStore.getState().bootState).toBe('pending');
    });
  });
});
