/**
 * Product version — single source of truth.
 *
 * Read from root package.json at build time via Vite's JSON import.
 * All version displays (SettingsPanel, GatewayClient, diagnostics)
 * must import from here instead of hardcoding.
 */
import rootPkg from '../../package.json';

export const RC_VERSION: string = rootPkg.version ?? '0.0.0';
