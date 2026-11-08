import { describe, expect, it } from 'vitest';
import { teamRequestError } from './request-error';
describe('team request errors', () => {
 it('explains frontend/backend version skew', () => {
  expect(teamRequestError(new Error('GatewayRequestError: unknown method: rc.team.list'))).toContain('重启');
  expect(teamRequestError(new Error('unknown method: rc.team.create'))).toContain('当前网关');
 });
 it('keeps other failures actionable', () => {
  expect(teamRequestError(new Error('database unavailable'))).toBe('database unavailable');
 });
});
