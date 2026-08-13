import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRODUCT_POLICY,
  parseProductPolicy,
  type ProductPolicy,
} from '../product-policy.js';

interface PolicyContract {
  schemaVersion: number;
  defaultCase: { name: string; expected: ProductPolicy };
  validCases: Array<{ name: string; input: unknown; expected: ProductPolicy }>;
  invalidCases: Array<{ name: string; input: unknown }>;
}

const contract = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../../test/fixtures/product-policy-contract-v1.json'),
  'utf8',
)) as PolicyContract;

describe('Research-Claw product policy', () => {
  it('defaults a completely absent policy from the shared v1 contract', () => {
    expect(contract.schemaVersion).toBe(1);
    expect(parseProductPolicy(undefined)).toEqual(contract.defaultCase.expected);
    expect(parseProductPolicy(undefined)).toEqual(DEFAULT_PRODUCT_POLICY);
  });

  it.each(contract.validCases)('accepts $name', ({ input, expected }) => {
    expect(parseProductPolicy(input)).toEqual(expected);
  });

  it.each(contract.invalidCases)('rejects $name instead of guessing', ({ input }) => {
    expect(() => parseProductPolicy(input)).toThrow(/productPolicy/);
  });

  it('returns a fresh immutable value instead of sharing mutable defaults', () => {
    const first = parseProductPolicy(undefined);
    const second = parseProductPolicy(undefined);
    expect(first).not.toBe(second);
    expect(first.capabilities).not.toBe(second.capabilities);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.capabilities)).toBe(true);
  });
});
