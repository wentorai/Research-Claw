'use strict';

const crypto = require('node:crypto');

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function jobsDigest(jobs) {
  if (!Array.isArray(jobs)) throw new Error('invalid cron jobs');
  return crypto.createHash('sha256').update(JSON.stringify(canonical(jobs))).digest('hex');
}

module.exports = { jobsDigest };
