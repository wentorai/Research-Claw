/**
 * Wentor Connect Plugin — Platform Integration
 *
 * Connects the local Research-Claw instance to the wentor.ai platform:
 *   - OAuth2 PKCE authentication flow
 *   - Bidirectional skills synchronization
 *   - Research activity summary uploads
 *
 * Configuration is read from openclaw.json:
 *   plugins.entries.wentor-connect.config.baseUrl  (default: https://wentor.ai)
 *   plugins.entries.wentor-connect.config.clientId  (default: research-claw-local)
 *
 * This plugin is disabled by default in openclaw.json. Enable it when
 * the user wants to connect their local Research-Claw to a wentor.ai account.
 */

import { WentorApiClient } from './src/api.js';
import { AuthManager, type AuthTokens } from './src/auth.js';
import { SyncManager, type LocalSkillProvider, type ActivityProvider } from './src/sync.js';

// ---------------------------------------------------------------------------
// Plugin config shape
// ---------------------------------------------------------------------------

interface WentorConnectConfig {
  baseUrl?: string;
  clientId?: string;
  callbackPort?: number;
}

// ---------------------------------------------------------------------------
// Minimal plugin API types (contract-compatible with OpenClaw)
// ---------------------------------------------------------------------------

interface PluginLogger {
  info(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  debug?(message: string): void;
}

interface PluginApi {
  logger: PluginLogger;
  getConfig<T = unknown>(): T;
  registerRpcMethod?(method: string, handler: (params: unknown) => Promise<unknown>): void;
}

interface OpenClawPluginDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  register(api: PluginApi): void;
}

// ---------------------------------------------------------------------------
// Token persistence (stored in workspace .research-claw/ directory)
// ---------------------------------------------------------------------------

let persistedTokens: AuthTokens | null = null;

function loadPersistedTokens(): AuthTokens | null {
  // In a real implementation, this would read from a secure file
  // e.g., .research-claw/wentor-tokens.json (encrypted)
  return persistedTokens;
}

function savePersistedTokens(tokens: AuthTokens | null): void {
  persistedTokens = tokens;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: OpenClawPluginDefinition = {
  id: 'wentor-connect',
  name: 'Wentor Connect',
  description: 'Connect Research-Claw to your wentor.ai account for skills sync and activity tracking',
  version: '0.4.2',

  register(api: PluginApi) {
    const config = api.getConfig<WentorConnectConfig>() ?? {};
    const baseUrl = config.baseUrl ?? 'https://wentor.ai';
    const clientId = config.clientId ?? 'research-claw-local';
    const callbackPort = config.callbackPort ?? 19876;

    api.logger.info(`Wentor Connect loaded (target: ${baseUrl})`);

    // Initialize components
    const apiClient = new WentorApiClient({ baseUrl });
    const authManager = new AuthManager(apiClient, { baseUrl, clientId, callbackPort });
    const syncManager = new SyncManager(apiClient, authManager);

    // Load persisted tokens
    const savedTokens = loadPersistedTokens();
    if (savedTokens) {
      authManager.loadTokens(savedTokens);
      api.logger.info('Restored saved authentication tokens');
    }

    // Persist tokens on change
    authManager.onTokensChanged = (tokens) => {
      savePersistedTokens(tokens);
    };

    // ── RPC Methods ──────────────────────────────────────────────────

    if (api.registerRpcMethod) {
      // wentor.auth.status — Check authentication status
      api.registerRpcMethod('wentor.auth.status', async () => {
        return authManager.state;
      });

      // wentor.auth.login — Start OAuth login flow
      api.registerRpcMethod('wentor.auth.login', async () => {
        const { authUrl, waitForCompletion } = await authManager.login();
        // Note: The caller should open authUrl in the user's browser.
        // waitForCompletion() resolves when the callback is received.
        // For the RPC interface, we return the URL and let the dashboard handle it.
        return { auth_url: authUrl, message: 'Open this URL in your browser to authenticate.' };
      });

      // wentor.auth.logout — Logout and clear tokens
      api.registerRpcMethod('wentor.auth.logout', async () => {
        await authManager.logout();
        return { ok: true, message: 'Logged out from wentor.ai' };
      });

      // wentor.sync.skills — Synchronize skills with platform
      api.registerRpcMethod('wentor.sync.skills', async () => {
        const result = await syncManager.syncSkills();
        return result;
      });

      // wentor.sync.activity — Upload activity summary
      api.registerRpcMethod('wentor.sync.activity', async (params: unknown) => {
        const p = params as { period?: string } | undefined;
        const period = p?.period ?? 'today';
        return syncManager.uploadActivity(period);
      });

      // wentor.health — Check platform connectivity
      api.registerRpcMethod('wentor.health', async () => {
        const result = await apiClient.healthCheck();
        return {
          platform_reachable: result.ok,
          authenticated: authManager.state.isAuthenticated,
          username: authManager.state.username,
          base_url: baseUrl,
        };
      });
    }
  },
};

export default plugin;

// Re-export types for consumers
export type { AuthTokens, WentorConnectConfig };
export { WentorApiClient, AuthManager, SyncManager };
export type { LocalSkillProvider, ActivityProvider };
