import { beforeEach, describe, expect, it } from 'vitest';

import { useProductPolicyStore } from './product-policy';
import { normalizeRightPanelForPolicy, useUiStore } from './ui';

const CUSTOMIZED = {
  capabilities: {
    settings: 'enabled-hidden',
    extensions: 'enabled-hidden',
    supervisor: 'enabled-hidden',
    peripherals: 'disabled',
  },
} as const;

describe('UI store product-policy authority', () => {
  const loadPolicy = (policy: typeof CUSTOMIZED | {
    capabilities: {
      settings: 'enabled';
      extensions: 'enabled';
      supervisor: 'enabled';
      peripherals: 'enabled';
    };
  }) => useProductPolicyStore.getState().loadFromConfig({
    plugins: {
      entries: {
        'research-claw-core': { config: { productPolicy: policy } },
      },
    },
  });

  beforeEach(() => {
    localStorage.clear();
    useProductPolicyStore.getState().resetPending();
    useUiStore.setState({ rightPanelTab: 'library', rightPanelOpen: false });
  });

  it('rejects direct hidden-tab navigation without opening a fallback panel', () => {
    loadPolicy(CUSTOMIZED);
    expect(useUiStore.getState().setRightPanelTab('settings')).toBe(false);
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: false });
    expect(localStorage.getItem('rc-right-panel-tab')).toBe('library');
    expect(localStorage.getItem('rc-right-panel-open')).not.toBe('true');
  });

  it('normalizes a hidden legacy localStorage tab while preserving panel open state', () => {
    localStorage.setItem('rc-right-panel-tab', 'extensions');
    localStorage.setItem('rc-right-panel-open', 'true');
    useUiStore.setState({ rightPanelTab: 'extensions', rightPanelOpen: true });
    loadPolicy(CUSTOMIZED);

    normalizeRightPanelForPolicy();

    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'library', rightPanelOpen: true });
    expect(localStorage.getItem('rc-right-panel-tab')).toBe('library');
  });

  it('refuses to open any panel while policy is pending or invalid', () => {
    expect(useUiStore.getState().setRightPanelTab('library')).toBe(false);
    expect(useUiStore.getState().rightPanelOpen).toBe(false);

    useProductPolicyStore.setState({ status: 'error', policy: null, error: 'invalid' });
    expect(useUiStore.getState().setRightPanelTab('workspace')).toBe(false);
    expect(useUiStore.getState().rightPanelOpen).toBe(false);
  });

  it('routes workspace previews through the same central panel gate', () => {
    expect(useUiStore.getState().requestWorkspacePreview('/workspace/secret.md')).toBe(false);
    expect(useUiStore.getState()).toMatchObject({
      rightPanelTab: 'library',
      rightPanelOpen: false,
      pendingPreviewPath: null,
    });

    useProductPolicyStore.setState({ status: 'error', policy: null, error: 'invalid' });
    expect(useUiStore.getState().requestWorkspacePreview('/workspace/error.md')).toBe(false);
    expect(useUiStore.getState()).toMatchObject({
      rightPanelTab: 'library',
      rightPanelOpen: false,
      pendingPreviewPath: null,
    });

    loadPolicy({
      capabilities: {
        settings: 'enabled',
        extensions: 'enabled',
        supervisor: 'enabled',
        peripherals: 'enabled',
      },
    });
    expect(useUiStore.getState().requestWorkspacePreview('/workspace/visible.md')).toBe(true);
    expect(useUiStore.getState()).toMatchObject({
      rightPanelTab: 'workspace',
      rightPanelOpen: true,
      pendingPreviewPath: '/workspace/visible.md',
    });
  });

  it('preserves all-enabled direct navigation', () => {
    loadPolicy({
      capabilities: {
        settings: 'enabled',
        extensions: 'enabled',
        supervisor: 'enabled',
        peripherals: 'enabled',
      },
    });
    expect(useUiStore.getState().setRightPanelTab('settings')).toBe(true);
    expect(useUiStore.getState()).toMatchObject({ rightPanelTab: 'settings', rightPanelOpen: true });
  });
});
