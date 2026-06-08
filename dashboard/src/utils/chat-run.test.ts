import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../stores/chat';
import { isActiveChatRun } from './chat-run';

describe('isActiveChatRun', () => {
  beforeEach(() => {
    useChatStore.setState({
      runId: null,
      sending: false,
      streaming: false,
    });
  });

  it('is true when runId is set', () => {
    useChatStore.setState({ runId: 'run-1' });
    expect(isActiveChatRun()).toBe(true);
  });

  it('is false when idle', () => {
    expect(isActiveChatRun()).toBe(false);
  });
});
