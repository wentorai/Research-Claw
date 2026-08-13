import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import CoreRuntimeAlert from './CoreRuntimeAlert';
import { useGatewayStore } from '../stores/gateway';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (key: string) => ({
      'coreRuntime.title': 'Research-Claw Core did not start',
      'coreRuntime.description': 'Your local data is still present.',
      'coreRuntime.compact': 'This is not empty data.',
      'coreRuntime.retry': 'Retry',
    }[key] ?? key),
  }),
}));

describe('CoreRuntimeAlert', () => {
  beforeEach(() => useGatewayStore.setState({ coreFailure: null }));
  afterEach(() => useGatewayStore.setState({ coreFailure: null }));

  it('stays hidden while the Core capability sentinel is healthy', () => {
    const { container } = render(<CoreRuntimeAlert />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains that unavailable Core data is not an empty collection', () => {
    useGatewayStore.setState({
      coreFailure: {
        method: 'rc.review.candidates',
        message: 'unknown method: rc.review.candidates',
        detectedAt: 123,
      },
    });

    render(<CoreRuntimeAlert compact />);

    expect(screen.getByRole('alert')).toHaveTextContent('Research-Claw Core did not start');
    expect(screen.getByRole('alert')).toHaveTextContent('This is not empty data.');
    expect(screen.getByRole('button', { name: /Retry/ })).toBeEnabled();
  });
});
