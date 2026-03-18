/**
 * Monitor system — RPC methods
 *
 * 10 methods:
 *   - rc.monitor.list       → list all monitors (with optional filters)
 *   - rc.monitor.get        → get a single monitor with last_results
 *   - rc.monitor.create     → create + auto-register gateway cron job
 *   - rc.monitor.update     → update config + sync gateway cron job
 *   - rc.monitor.delete     → delete + remove gateway cron job
 *   - rc.monitor.toggle     → quick enable/disable
 *   - rc.monitor.run        → manual trigger via gateway cron.run
 *   - rc.monitor.history    → execution history via gateway cron.runs
 *   - rc.monitor.report     → persist scan results with fingerprints
 *   - rc.monitor.setJobId   → bind gateway job ID
 *   - rc.monitor.getContext  → load config + memory for agent execution
 *   - rc.monitor.updateNote  → write/update adaptive notes
 */

import type { RegisterMethod } from '../types.js';
import { MonitorService, type MonitorInput, type MonitorPatch } from './service.js';

// ── Validation helpers ────────────────────────────────────────────────

class RpcValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'RpcValidationError'; }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RpcValidationError(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new RpcValidationError(`${field} must be a string`);
  return value;
}

function optionalNumber(value: unknown, field: string, min?: number, max?: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number') throw new RpcValidationError(`${field} must be a number`);
  if (min !== undefined && value < min) throw new RpcValidationError(`${field} must be >= ${min}`);
  if (max !== undefined && value > max) throw new RpcValidationError(`${field} must be <= ${max}`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw new RpcValidationError(`${field} must be a boolean`);
  return value;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new RpcValidationError(`${field} must be an object`);
  return value as Record<string, unknown>;
}

// ── RPC registration ──────────────────────────────────────────────────

export function registerMonitorRpc(registerMethod: RegisterMethod, service: MonitorService): void {
  // ── rc.monitor.list ──────────────────────────────────────────────
  registerMethod('rc.monitor.list', async (params: Record<string, unknown>) => {
    try {
      const enabled = optionalBoolean(params.enabled, 'enabled');
      const source_type = optionalString(params.source_type, 'source_type');
      const limit = optionalNumber(params.limit, 'limit', 1, 100);
      const offset = optionalNumber(params.offset, 'offset', 0);

      return service.list({ enabled, source_type, limit, offset });
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.get ───────────────────────────────────────────────
  registerMethod('rc.monitor.get', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      return service.get(id);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.create ────────────────────────────────────────────
  registerMethod('rc.monitor.create', async (params: Record<string, unknown>) => {
    try {
      const input: MonitorInput = {
        name: requireString(params.name, 'name'),
        source_type: requireString(params.source_type, 'source_type'),
        target: optionalString(params.target, 'target'),
        filters: optionalObject(params.filters, 'filters'),
        schedule: optionalString(params.schedule, 'schedule'),
        enabled: optionalBoolean(params.enabled, 'enabled'),
        notify: optionalBoolean(params.notify, 'notify'),
        agent_prompt: optionalString(params.agent_prompt, 'agent_prompt'),
      };

      const monitor = service.create(input);
      return monitor;
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.update ────────────────────────────────────────────
  registerMethod('rc.monitor.update', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');

      const patch: MonitorPatch = {};
      if (params.name !== undefined) patch.name = requireString(params.name, 'name');
      if (params.source_type !== undefined) patch.source_type = requireString(params.source_type, 'source_type');
      if (params.target !== undefined) patch.target = optionalString(params.target, 'target');
      if (params.filters !== undefined) patch.filters = optionalObject(params.filters, 'filters');
      if (params.schedule !== undefined) patch.schedule = optionalString(params.schedule, 'schedule');
      if (params.enabled !== undefined) patch.enabled = optionalBoolean(params.enabled, 'enabled');
      if (params.notify !== undefined) patch.notify = optionalBoolean(params.notify, 'notify');
      if (params.agent_prompt !== undefined) patch.agent_prompt = optionalString(params.agent_prompt, 'agent_prompt');

      const monitor = service.update(id, patch);
      return monitor;
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.delete ────────────────────────────────────────────
  registerMethod('rc.monitor.delete', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      return service.delete(id);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.toggle ────────────────────────────────────────────
  registerMethod('rc.monitor.toggle', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const enabled = params.enabled;
      if (typeof enabled !== 'boolean') throw new RpcValidationError('enabled is required and must be a boolean');
      return service.toggle(id, enabled);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.run ───────────────────────────────────────────────
  // Manual trigger — the dashboard calls cron.run on the gateway side,
  // but we expose this RPC so the dashboard can resolve monitor_id → gateway_job_id.
  registerMethod('rc.monitor.run', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const monitor = service.get(id);
      if (!monitor.gateway_job_id) {
        throw new Error('Monitor has no gateway job registered. Enable it first.');
      }
      return { ok: true, gateway_job_id: monitor.gateway_job_id };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.history ───────────────────────────────────────────
  // Returns gateway_job_id so the dashboard can call cron.runs directly.
  registerMethod('rc.monitor.history', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const monitor = service.get(id);
      return {
        monitor_id: id,
        gateway_job_id: monitor.gateway_job_id,
        last_check_at: monitor.last_check_at,
        last_error: monitor.last_error,
        check_count: monitor.check_count,
        finding_count: monitor.finding_count,
      };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.report ────────────────────────────────────────────
  // Called by agent tools to persist scan results with fingerprints.
  registerMethod('rc.monitor.report', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const results = params.results;
      if (!Array.isArray(results)) throw new RpcValidationError('results must be an array');
      const fingerprints = Array.isArray(params.fingerprints) ? params.fingerprints.map(String) : [];
      const summary = optionalString(params.summary, 'summary');

      return service.report(id, results, fingerprints, summary);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.setJobId ──────────────────────────────────────────
  // Dashboard calls this after cron.add to persist the gateway job ID.
  // Accepts empty string or null to clear the job ID (when disabling a monitor).
  registerMethod('rc.monitor.setJobId', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      // Allow empty string / null to clear gateway_job_id on disable
      const rawJobId = params.job_id;
      const job_id = (typeof rawJobId === 'string' && rawJobId.trim()) ? rawJobId.trim() : null;
      service.setGatewayJobId(id, job_id);
      return { ok: true };
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.getContext ────────────────────────────────────────
  registerMethod('rc.monitor.getContext', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      return service.getContext(id);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });

  // ── rc.monitor.updateNote ────────────────────────────────────────
  registerMethod('rc.monitor.updateNote', async (params: Record<string, unknown>) => {
    try {
      const id = requireString(params.id, 'id');
      const note = requireString(params.note, 'note');
      return service.updateNote(id, note);
    } catch (err) {
      throw err instanceof RpcValidationError ? new Error(err.message) : err;
    }
  });
}
