/**
 * OpenClaw 2026.6.1 session active-state parity.
 *
 * Reference: openclaw/ui/src/ui/session-run-state.ts and its table tests.
 */
import { describe, expect, it } from 'vitest';

import { OC_SESSION_ACTIVE_CASES } from '../../__fixtures__/gateway-payloads/session-run-state';
import { isSessionRunActive } from '../../utils/session-run-state';

describe('session run active parity with OpenClaw 2026.6.1', () => {
  it.each(OC_SESSION_ACTIVE_CASES)('$name', ({ row, active }) => {
    expect(isSessionRunActive(row)).toBe(active);
  });
});

