import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { jobsDigest } = require('../scripts/bootstrap-profile/cron-digest.cjs');

describe('bootstrap cron CAS digest', () => {
  it('uses one canonical digest independent of object insertion order', () => {
    expect(jobsDigest([{ id: 'job', enabled: true, state: { b: 2, a: 1 } }]))
      .toBe(jobsDigest([{ state: { a: 1, b: 2 }, enabled: true, id: 'job' }]));
    expect(jobsDigest([{ id: 'job', enabled: true }]))
      .not.toBe(jobsDigest([{ id: 'job', enabled: false }]));
  });
});
