import { describe, expect, it } from 'vitest';
import { snapshotMessageSendingCtx } from '../hooks/hook-context.js';

describe('snapshotMessageSendingCtx', () => {
  it('does not defer when only stream:true (transport hint on final message)', () => {
    const snap = snapshotMessageSendingCtx({
      message: 'full text',
      stream: true,
    });
    expect(snap.deferReview).toBe(false);
  });

  it('defers on partial:true', () => {
    const snap = snapshotMessageSendingCtx({
      message: 'chunk',
      partial: true,
    });
    expect(snap.deferReview).toBe(true);
  });

  it('does not defer when isFinal/done/complete is true', () => {
    for (const ctx of [
      { message: 'x', isFinal: true },
      { message: 'x', done: true },
      { message: 'x', complete: true },
    ]) {
      expect(snapshotMessageSendingCtx(ctx).deferReview).toBe(false);
    }
  });

  describe('channel delivery detection', () => {
    it('detects channel delivery via channel field', () => {
      const snap = snapshotMessageSendingCtx({
        message: 'hello',
        channel: 'openclaw-weixin',
      });
      expect(snap.isChannelDelivery).toBe(true);
    });

    it('detects channel delivery via deliveryMode=direct', () => {
      const snap = snapshotMessageSendingCtx({
        message: 'hello',
        deliveryMode: 'direct',
      });
      expect(snap.isChannelDelivery).toBe(true);
    });

    it('detects channel delivery via deliveryMode=announce', () => {
      const snap = snapshotMessageSendingCtx({
        message: 'hello',
        deliveryMode: 'announce',
      });
      expect(snap.isChannelDelivery).toBe(true);
    });

    it('detects channel delivery via source field', () => {
      for (const source of ['telegram', 'weixin', 'wechat', 'discord', 'feishu', 'slack']) {
        const snap = snapshotMessageSendingCtx({
          message: 'hello',
          source,
        });
        expect(snap.isChannelDelivery).toBe(true);
      }
    });

    it('detects channel delivery via nested delivery object', () => {
      const snap = snapshotMessageSendingCtx({
        message: 'hello',
        delivery: { channel: 'telegram', mode: 'direct' },
      });
      expect(snap.isChannelDelivery).toBe(true);
    });

    it('does not detect channel delivery for Dashboard messages', () => {
      const snap = snapshotMessageSendingCtx({
        message: 'hello',
        sessionId: 'main',
      });
      expect(snap.isChannelDelivery).toBe(false);
    });

    it('does not detect channel delivery for empty source', () => {
      const snap = snapshotMessageSendingCtx({
        message: 'hello',
        source: '',
      });
      expect(snap.isChannelDelivery).toBe(false);
    });
  });
});
