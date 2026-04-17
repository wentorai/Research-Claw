/**
 * Dual Model Supervisor — RPC Method Registration
 *
 * Registers rc.supervisor.* RPC methods for Dashboard communication.
 */

import type { RegisterMethod, SupervisorConfig, PluginLogger, ConfiguredProvider } from './core/types.js';
import { DEFAULT_CONFIG } from './core/types.js';
import { AuditLogService } from './core/audit-log.js';
import { parseConfig } from './core/config.js';

/**
 * Register all `rc.supervisor.*` RPC methods for Dashboard communication.
 * @param registerMethod     Gateway method registration callback
 * @param auditLog           Shared audit log service instance
 * @param getActiveConfig    Returns the current effective SupervisorConfig
 * @param setActiveConfig    Updates the active config and propagates to all components
 * @param logger             Plugin logger
 * @param getSessionStates   Returns the live session state map (optional)
 * @param getConfiguredProviders Returns the available model providers for reviewer (optional)
 */
export function registerSupervisorRpc(
  registerMethod: RegisterMethod,
  auditLog: AuditLogService,
  getActiveConfig: () => SupervisorConfig,
  setActiveConfig: (cfg: SupervisorConfig) => void,
  logger: PluginLogger,
  getSessionStates?: () => Map<string, import('./core/types.js').SessionState>,
  getConfiguredProviders?: () => ConfiguredProvider[],
): void {
  registerMethod('rc.supervisor.status', async () => {
    const cfg = getActiveConfig();
    const stats = auditLog.getStats();

    // Include active session info if available
    let activeSessions = 0;
    let sessionsInfo: Array<{ sessionId: string; researchGoal?: string; targetConclusions: string[]; goalConfirmed: boolean }> = [];
    if (getSessionStates) {
      const states = getSessionStates();
      activeSessions = states.size;
      for (const [, state] of states) {
        sessionsInfo.push({
          sessionId: state.sessionId,
          researchGoal: state.researchGoal,
          targetConclusions: state.targetConclusions,
          goalConfirmed: state.goalConfirmed,
        });
      }
    }

    return {
      enabled: cfg.enabled,
      reviewMode: cfg.reviewMode,
      supervisorModel: cfg.supervisorModel,
      appendReviewToChannelOutput: cfg.appendReviewToChannelOutput,
      memoryGuardEnabled: cfg.memoryGuard.enabled,
      courseCorrectionEnabled: cfg.courseCorrection.enabled,
      deviationThreshold: cfg.courseCorrection.deviationThreshold,
      forceRegenerate: cfg.courseCorrection.forceRegenerate,
      maxRegenerateAttempts: cfg.courseCorrection.maxRegenerateAttempts,
      highRiskTools: cfg.highRiskTools,
      stats,
      activeSessions,
      sessionsInfo,
    };
  });

  registerMethod('rc.supervisor.config', async (params) => {
    if (params && typeof params === 'object' && Object.keys(params).length > 0) {
      const current = getActiveConfig();
      // Only accept known config keys — reject arbitrary params
      const ALLOWED_KEYS = [
        'enabled', 'supervisorModel', 'reviewMode',
        'appendReviewToChannelOutput', 'memoryGuard',
        'courseCorrection', 'highRiskTools',
      ] as const;
      const filtered: Record<string, unknown> = {};
      for (const key of ALLOWED_KEYS) {
        if (key in (params as Record<string, unknown>)) {
          filtered[key] = (params as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(filtered).length === 0) {
        return { ok: true, config: current };
      }
      const updated = parseConfig({ ...current, ...filtered });
      setActiveConfig(updated);
      logger.info(`Supervisor config updated: mode=${updated.reviewMode}, model=${updated.supervisorModel}`);
      return { ok: true, config: updated };
    }
    return { ok: true, config: getActiveConfig() };
  });

  registerMethod('rc.supervisor.log', async (params) => {
    const p = params as { limit?: number; offset?: number; sessionId?: string; type?: import('./core/types.js').AuditLogType; action?: string };
    const entries = auditLog.list({
      limit: p.limit ?? 50,
      offset: p.offset ?? 0,
      sessionId: p.sessionId,
      type: p.type,
      action: p.action,
    });
    return { entries, total: entries.length };
  });

  registerMethod('rc.supervisor.stats', async () => {
    return auditLog.getStats();
  });

  registerMethod('rc.supervisor.toggle', async (params) => {
    const p = params as { enabled?: boolean };
    const current = getActiveConfig();
    const enabled = p.enabled ?? !current.enabled;
    const updated = {
      ...current,
      enabled,
      reviewMode: enabled && current.reviewMode === 'off' ? 'correct' as const : current.reviewMode,
    };
    setActiveConfig(updated);
    logger.info(`Supervisor ${enabled ? 'enabled' : 'disabled'}`);
    return { ok: true, enabled: updated.enabled, reviewMode: updated.reviewMode };
  });

  registerMethod('rc.supervisor.defaults', async () => {
    return { defaults: DEFAULT_CONFIG };
  });

  registerMethod('rc.supervisor.providers', async () => {
    if (!getConfiguredProviders) return { providers: [] };
    const providers = getConfiguredProviders();
    return { providers };
  });
}
