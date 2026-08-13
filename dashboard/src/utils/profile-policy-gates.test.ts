import { describe, expect, it } from 'vitest';

import {
  canOpenPanel,
  firstVisiblePanel,
  shouldMountPeripheralsListener,
  shouldMountSupervisorUiHydration,
  visiblePanelTabs,
  visibleShortcutTabs,
  type ProductPolicy,
} from './profile-policy';
import type { PanelTab } from '../stores/ui';

const ALL_PANELS: PanelTab[] = [
  'library',
  'workspace',
  'review',
  'tasks',
  'jobs',
  'monitor',
  'peripherals',
  'supervisor',
  'extensions',
  'settings',
];

const SHORTCUT_BASELINE: PanelTab[] = [
  'library',
  'workspace',
  'review',
  'tasks',
  'monitor',
  'supervisor',
  'extensions',
  'settings',
];

function policy(overrides: Partial<ProductPolicy['capabilities']> = {}): ProductPolicy {
  return {
    capabilities: {
      settings: 'enabled',
      extensions: 'enabled',
      supervisor: 'enabled',
      peripherals: 'enabled',
      ...overrides,
    },
  };
}

describe('Dashboard policy gate matrix', () => {
  it('preserves the all-enabled panel and shortcut inventory', () => {
    const enabled = policy();
    expect(visiblePanelTabs(ALL_PANELS, enabled)).toEqual(ALL_PANELS);
    expect(visibleShortcutTabs(SHORTCUT_BASELINE, enabled)).toEqual(SHORTCUT_BASELINE);
    for (const tab of ALL_PANELS) expect(canOpenPanel(tab, enabled), tab).toBe(true);
  });

  it('hides every customized panel from navigation and shortcut routes', () => {
    const customized = policy({
      settings: 'enabled-hidden',
      extensions: 'enabled-hidden',
      supervisor: 'enabled-hidden',
      peripherals: 'disabled',
    });
    expect(visiblePanelTabs(ALL_PANELS, customized)).toEqual([
      'library', 'workspace', 'review', 'tasks', 'jobs', 'monitor',
    ]);
    expect(visibleShortcutTabs(SHORTCUT_BASELINE, customized)).toEqual([
      'library', 'workspace', 'review', 'tasks', 'monitor',
    ]);
    for (const tab of ['settings', 'extensions', 'supervisor', 'peripherals'] as const) {
      expect(canOpenPanel(tab, customized), tab).toBe(false);
    }
    expect(firstVisiblePanel(customized)).toBe('library');
  });

  it('distinguishes hidden-but-running peripherals from fully disabled peripherals', () => {
    const hidden = policy({ peripherals: 'enabled-hidden' });
    const disabled = policy({ peripherals: 'disabled' });
    expect(canOpenPanel('peripherals', hidden)).toBe(false);
    expect(shouldMountPeripheralsListener(hidden)).toBe(true);
    expect(canOpenPanel('peripherals', disabled)).toBe(false);
    expect(shouldMountPeripheralsListener(disabled)).toBe(false);
  });

  it('stops only supervisor UI hydration when supervision is hidden', () => {
    expect(shouldMountSupervisorUiHydration(policy())).toBe(true);
    expect(shouldMountSupervisorUiHydration(policy({ supervisor: 'enabled-hidden' }))).toBe(false);
  });
});
