import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

import { useMonitorStore } from '../stores/monitor';
import { useProductPolicyStore } from '../stores/product-policy';
import MonitorPolicyReconciler from './MonitorPolicyReconciler';

describe('MonitorPolicyReconciler', () => {
  const loadMonitors = vi.fn().mockResolvedValue(undefined);
  const originalLoadMonitors = useMonitorStore.getState().loadMonitors;

  beforeEach(() => {
    loadMonitors.mockClear();
    useMonitorStore.setState({ loadMonitors });
    useProductPolicyStore.getState().resetPending();
  });

  afterEach(() => {
    useMonitorStore.setState({ loadMonitors: originalLoadMonitors });
  });

  it('does no hydration while policy is pending', () => {
    render(<MonitorPolicyReconciler />);
    expect(loadMonitors).not.toHaveBeenCalled();
  });

  it('hydrates once the normalized policy becomes ready', () => {
    useProductPolicyStore.getState().loadFromConfig({});
    render(<MonitorPolicyReconciler />);
    expect(loadMonitors).toHaveBeenCalledTimes(1);
  });

  it('actively hydrates on a pending to ready transition without opening MonitorPanel', () => {
    render(<MonitorPolicyReconciler />);
    expect(loadMonitors).not.toHaveBeenCalled();

    act(() => useProductPolicyStore.getState().loadFromConfig({}));

    expect(loadMonitors).toHaveBeenCalledTimes(1);
  });
});
