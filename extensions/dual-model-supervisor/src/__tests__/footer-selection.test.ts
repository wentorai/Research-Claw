/**
 * P1-B (reopened) — pure footer-selection logic.
 *
 * Guards the correlation used by message_sending. Beyond hash/consumed/turn
 * filtering, the load-bearing case is DUPLICATE CONTENT: two byte-identical turns
 * in one session produce footers with the SAME outputHash. Their async reviews may
 * complete OUT OF ORDER, so pendingFooters can hold [newerTurn, olderTurn]. The
 * selector must pick the OLDEST turn first — otherwise delivering the older turn's
 * outbound consumes the newer entry and advances lastDeliveredTurnSeq past the
 * older turn, silently withholding one of the two footers (reviewer finding #2).
 */

import { describe, expect, it } from 'vitest';
import { selectPendingFooter } from '../../index.js';
import type { PendingFooter } from '../core/types.js';

const F = (turnSeq: number, outputHash: string, consumed = false): PendingFooter => ({
  turnSeq,
  outputHash,
  footer: `footer-${turnSeq}`,
  createdAt: 1000 + turnSeq,
  consumed,
});

describe('selectPendingFooter', () => {
  it('filters by content hash', () => {
    const footers = [F(1, 'HA'), F(2, 'HB')];
    expect(selectPendingFooter(footers, 'HB', 0)?.turnSeq).toBe(2);
    expect(selectPendingFooter(footers, 'HZ', 0)).toBeUndefined();
  });

  it('never returns a consumed footer', () => {
    const footers = [F(1, 'H', true)];
    expect(selectPendingFooter(footers, 'H', 0)).toBeUndefined();
  });

  it('never returns a footer for an already-delivered turn (turnSeq <= lastDelivered)', () => {
    const footers = [F(3, 'H')];
    expect(selectPendingFooter(footers, 'H', 3)).toBeUndefined();
    expect(selectPendingFooter(footers, 'H', 2)?.turnSeq).toBe(3);
  });

  it('picks the OLDEST turn among same-hash footers even when stored newest-first (out-of-order review completion)', () => {
    // Async reviews for two identical-content turns completed out of order:
    // turn 5 cached before turn 3, so the array holds [5, 3].
    const footers = [F(5, 'H'), F(3, 'H')];
    expect(selectPendingFooter(footers, 'H', 0)?.turnSeq).toBe(3); // oldest, not insertion-first
  });

  it('delivers both identical-content footers across two deliveries (no silent loss)', () => {
    const footers = [F(5, 'H'), F(3, 'H')];
    let lastDelivered = 0;

    const first = selectPendingFooter(footers, 'H', lastDelivered)!;
    expect(first.turnSeq).toBe(3);
    first.consumed = true;
    lastDelivered = Math.max(lastDelivered, first.turnSeq); // = 3

    const second = selectPendingFooter(footers, 'H', lastDelivered)!;
    expect(second.turnSeq).toBe(5); // the other identical-content footer still delivers
  });
});
