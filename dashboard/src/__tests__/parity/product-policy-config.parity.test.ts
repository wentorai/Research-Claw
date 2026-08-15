import { describe, expect, it } from 'vitest';

import customPolicyCapture from '../../__fixtures__/gateway-payloads/product-policy-custom.config-get-2026.6.1.json';
import noPolicyCapture from '../../__fixtures__/gateway-payloads/product-policy-none.config-get-2026.6.1.json';
import { parseProductPolicy } from '../../utils/profile-policy';

interface ConfigGetCapture {
  fixtureMeta: {
    openClawVersion: string;
    source: string;
    sanitization: string[];
  };
  response: {
    valid: boolean;
    issues: unknown[];
    config?: {
      plugins?: {
        entries?: Record<string, { config?: { productPolicy?: unknown } }>;
      };
    };
  };
}

function policyFrom(capture: ConfigGetCapture): unknown {
  return capture.response.config?.plugins?.entries?.['research-claw-core']
    ?.config?.productPolicy;
}

describe('OpenClaw 2026.6.1 config.get product-policy parity', () => {
  it.each([
    ['no policy', noPolicyCapture],
    ['custom policy', customPolicyCapture],
  ] as const)('keeps the %s capture provenance and schema health', (_name, capture) => {
    expect(capture.fixtureMeta.openClawVersion).toBe('2026.6.1');
    expect(capture.fixtureMeta.source).toContain('gateway call config.get');
    expect(capture.fixtureMeta.normalizedCaptureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(capture.fixtureMeta.sanitization.length).toBeGreaterThan(0);
    expect(capture.response.valid).toBe(true);
    expect(capture.response.issues).toEqual([]);

    const serialized = JSON.stringify(capture);
    expect(serialized).not.toMatch(/(?:\/Users\/|\/var\/folders\/|[A-Za-z]:\\)/);
    expect(serialized).not.toContain('__OPENCLAW_REDACTED__');
    expect(serialized).not.toContain('RC_T05_FAKE');
    expect(serialized).not.toContain('<ISOLATED_TEMP>');
    expect(serialized).not.toContain('<RC_ROOT>');
  });

  it('normalizes an ordinary config with no policy to all enabled', () => {
    expect(policyFrom(noPolicyCapture)).toBeUndefined();
    expect(parseProductPolicy(policyFrom(noPolicyCapture))).toEqual({
      capabilities: {
        settings: 'enabled',
        extensions: 'enabled',
        supervisor: 'enabled',
        peripherals: 'enabled',
      },
    });
  });

  it('preserves the customized policy exactly', () => {
    const parsed = parseProductPolicy(policyFrom(customPolicyCapture));
    expect(parsed.capabilities).toEqual({
      settings: 'enabled-hidden',
      extensions: 'enabled-hidden',
      supervisor: 'enabled-hidden',
      peripherals: 'disabled',
    });
  });
});
