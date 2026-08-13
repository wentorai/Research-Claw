import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { useProductPolicyStore } from '../stores/product-policy';
import ProductPolicyRuntime from './ProductPolicyRuntime';

vi.mock('./PeriphCaptureListener', () => ({
  default: () => <div data-testid="peripherals-listener" />,
}));
vi.mock('./SupervisorReviewListener', () => ({
  default: () => <div data-testid="supervisor-listener" />,
}));
vi.mock('./MonitorPolicyReconciler', () => ({
  default: () => <div data-testid="monitor-reconciler" />,
}));

function loadPolicy(
  peripherals: 'enabled' | 'enabled-hidden' | 'disabled',
  supervisor: 'enabled' | 'enabled-hidden',
) {
  useProductPolicyStore.getState().loadFromConfig({
    plugins: {
      entries: {
        'research-claw-core': {
          config: {
            productPolicy: {
              capabilities: {
                settings: 'enabled-hidden',
                extensions: 'enabled-hidden',
                supervisor,
                peripherals,
              },
            },
          },
        },
      },
    },
  });
}

describe('product policy runtime listener matrix', () => {
  beforeEach(() => useProductPolicyStore.getState().resetPending());
  afterEach(() => cleanup());

  it('stops hidden supervision and disabled peripherals without owning the global approval surface', () => {
    loadPolicy('disabled', 'enabled-hidden');
    render(<ProductPolicyRuntime />);

    expect(screen.getByTestId('monitor-reconciler')).toBeInTheDocument();
    expect(screen.queryByTestId('supervisor-listener')).not.toBeInTheDocument();
    expect(screen.queryByTestId('peripherals-listener')).not.toBeInTheDocument();
  });

  it('keeps enabled-hidden peripherals running while keeping their panel hidden elsewhere', () => {
    loadPolicy('enabled-hidden', 'enabled-hidden');
    render(<ProductPolicyRuntime />);

    expect(screen.getByTestId('peripherals-listener')).toBeInTheDocument();
    expect(screen.queryByTestId('supervisor-listener')).not.toBeInTheDocument();
  });

  it('mounts the legacy all-enabled runtime listeners', () => {
    loadPolicy('enabled', 'enabled');
    render(<ProductPolicyRuntime />);

    expect(screen.getByTestId('peripherals-listener')).toBeInTheDocument();
    expect(screen.getByTestId('supervisor-listener')).toBeInTheDocument();
  });
});
