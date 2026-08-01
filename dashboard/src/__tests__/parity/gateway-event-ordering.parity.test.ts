/** Gateway event cursor parity: duplicates and reordered frames are not replayed. */
import { describe, expect, it, vi } from 'vitest';

import { GatewayClient } from '../../gateway/client';
import type { EventFrame } from '../../gateway/types';

function frame(seq: number, value: string): EventFrame {
  return { type: 'event', event: 'sessions.changed', seq, payload: { value } };
}

describe('gateway event ordering', () => {
  it('delivers each increasing seq once and reports a real forward gap once', () => {
    const received: string[] = [];
    const gaps: Array<{ expected: number; received: number }> = [];
    const client = new GatewayClient({
      url: 'ws://127.0.0.1:28789',
      onGap: (gap) => gaps.push(gap),
    });
    client.subscribe('sessions.changed', (payload) => {
      received.push((payload as { value: string }).value);
    });
    const handleEvent = (client as unknown as { handleEvent: (event: EventFrame) => void }).handleEvent.bind(client);

    handleEvent(frame(10, 'first'));
    handleEvent(frame(10, 'duplicate'));
    handleEvent(frame(9, 'late'));
    handleEvent(frame(12, 'after-gap'));

    expect(received).toEqual(['first', 'after-gap']);
    expect(gaps).toEqual([{ expected: 11, received: 12 }]);
  });
});
