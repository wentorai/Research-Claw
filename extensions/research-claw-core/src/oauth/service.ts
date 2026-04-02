/**
 * OAuth Service — Dashboard-initiated OAuth for RC.
 *
 * Handles PKCE generation, auth URL construction, token exchange,
 * and credential storage for OAuth providers (OpenAI Codex, etc.).
 *
 * Design: stateless except for in-flight PKCE verifiers (5-min TTL).
 * Token refresh is handled by OC's auth-profile system automatically.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import * as tls from 'node:tls';
import * as path from 'node:path';
import { URL } from 'node:url';

// ── Types ──────────────────────────────────────────────────────────────────

interface OAuthSession {
  provider: string;
  verifier: string;
  challenge: string;
  state: string;
  createdAt: number;
}

interface OAuthCredential {
  type: 'oauth';
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
}

interface ApiKeyCredential {
  type: 'api_key';
  provider: string;
  key: string;
}

// Matches OC's AuthProfileStore shape (agents/auth-profiles/types.ts).
// Extra fields (lastGood, usageStats, order) are preserved via JSON round-trip
// even though TypeScript doesn't enforce them here.
interface AuthProfileStore {
  version?: number;
  profiles: Record<string, OAuthCredential | ApiKeyCredential>;
  order?: Record<string, unknown>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, unknown>;
  [key: string]: unknown; // preserve any future OC fields
}

// ── Provider Definitions ───────────────────────────────────────────────────

interface OAuthProviderDef {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  profileId: string;
  extraAuthParams?: Record<string, string>;
}

const PROVIDERS: Record<string, OAuthProviderDef> = {
  'openai-codex': {
    authUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    profileId: 'openai-codex:codex-cli',
    extraAuthParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'pi',
    },
  },
};

// ── PKCE ───────────────────────────────────────────────────────────────────

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── Session Store (in-memory, 5-min TTL) ───────────────────────────────────

const SESSION_TTL_MS = 5 * 60 * 1000;
const sessions = new Map<string, OAuthSession>();

function cleanExpiredSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
}

// ── Auth Profile Storage ───────────────────────────────────────────────────

function resolveAuthStorePath(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || '/root';
  return path.join(homeDir, '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
}

function readAuthStore(): AuthProfileStore {
  const storePath = resolveAuthStorePath();
  try {
    return JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch {
    return { version: 1, profiles: {} };
  }
}

function defaultProfileId(provider: string): string {
  return `${provider}:manual`;
}

function ensureProviderOrder(store: AuthProfileStore, provider: string, profileId: string): void {
  const existing = Array.isArray(store.order?.[provider]) ? (store.order?.[provider] as string[]) : [];
  const deduped = [profileId, ...existing.filter((id) => id !== profileId)];
  store.order = { ...(store.order ?? {}), [provider]: deduped };
}

// Write auth store with atomic rename (write-to-temp-then-rename).
// OC internally uses withFileLock() for concurrency, but the plugin SDK doesn't
// expose file-lock utilities. Atomic rename is sufficient here because:
// 1. OAuth credential write is infrequent (explicit user action, not background)
// 2. OC's next read will see either old or new file, never partial
// 3. Even in a race with OC's token refresh, the result is valid credentials
function writeAuthStore(store: AuthProfileStore): void {
  const storePath = resolveAuthStorePath();
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true });
  const output = JSON.stringify(store, null, 2) + '\n';
  const tmp = storePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, output);
  fs.renameSync(tmp, storePath);
}

// ── Proxy-aware HTTP ───────────────────────────────────────────────────────

/**
 * Resolve proxy URL from environment or RC config.
 * Priority: HTTPS_PROXY > HTTP_PROXY > config.env.HTTPS_PROXY > config.env.HTTP_PROXY
 */
function resolveProxyUrl(): string | null {
  // 1. Environment variables (set by run.sh or user)
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy ||
                   process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return envProxy;

  // 2. RC config file (config/openclaw.json → env.HTTPS_PROXY)
  try {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (configPath) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return cfg?.env?.HTTPS_PROXY || cfg?.env?.HTTP_PROXY || null;
    }
  } catch { /* ignore */ }

  return null;
}

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * POST with proxy support via CONNECT tunnel + TLS (no external dependencies).
 * Falls back to direct request if no proxy configured or proxy fails.
 */
function proxyAwarePost(
  targetUrl: string,
  body: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const target = new URL(targetUrl);
  const proxyUrl = resolveProxyUrl();

  if (proxyUrl) {
    return tunnelPost(target, body, proxyUrl).catch(() => {
      // Proxy failed — fall back to direct
      return directPost(target, body);
    });
  }
  return directPost(target, body);
}

type TokenResult = { access_token: string; refresh_token: string; expires_in: number };

/**
 * Direct HTTPS POST (no proxy).
 */
function directPost(target: URL, body: string): Promise<TokenResult> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      method: 'POST',
      hostname: target.hostname,
      port: Number(target.port) || 443,
      path: target.pathname + target.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body).toString(),
        Host: target.hostname,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => collectResponse(res, resolve, reject));
    req.on('timeout', () => { req.destroy(); reject(new Error('Token exchange timed out (direct)')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * HTTPS POST through HTTP CONNECT tunnel.
 * 1. HTTP CONNECT to proxy → get raw TCP socket
 * 2. tls.connect over that socket → TLS-wrapped socket
 * 3. Write raw HTTP/1.1 request over TLS socket
 * 4. Parse response
 */
function tunnelPost(target: URL, body: string, proxyUrl: string): Promise<TokenResult> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const targetPort = Number(target.port) || 443;

    // Step 1: CONNECT to proxy
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 7890,
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      timeout: REQUEST_TIMEOUT_MS,
    });

    connectReq.on('timeout', () => { connectReq.destroy(); reject(new Error('Proxy CONNECT timed out')); });

    connectReq.on('connect', (connectRes, socket) => {
      if (connectRes.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${connectRes.statusCode}`));
        return;
      }

      // Step 2: TLS handshake over the tunneled socket
      const tlsSocket = tls.connect({
        socket: socket as import('node:net').Socket,
        host: target.hostname,
        servername: target.hostname,
      }, () => {
        // Step 3: Write raw HTTP/1.1 request
        const reqHeaders = [
          `POST ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.hostname}`,
          'Content-Type: application/x-www-form-urlencoded',
          `Content-Length: ${Buffer.byteLength(body)}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n');

        tlsSocket.write(reqHeaders + body);
      });

      tlsSocket.setTimeout(REQUEST_TIMEOUT_MS, () => {
        tlsSocket.destroy();
        reject(new Error('Token exchange timed out (tunnel)'));
      });

      // Step 4: Collect and parse response
      let rawData = '';
      tlsSocket.on('data', (chunk: Buffer) => { rawData += chunk.toString(); });
      tlsSocket.on('end', () => {
        // Parse HTTP response: split headers from body at \r\n\r\n
        const splitIdx = rawData.indexOf('\r\n\r\n');
        if (splitIdx < 0) {
          reject(new Error('Malformed HTTP response from token endpoint'));
          return;
        }
        const statusLine = rawData.slice(0, rawData.indexOf('\r\n'));
        const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);
        const statusCode = statusMatch ? Number(statusMatch[1]) : 0;
        const responseBody = rawData.slice(splitIdx + 4);

        if (statusCode >= 400) {
          reject(new Error(`Token exchange failed (${statusCode}): ${responseBody.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(new Error(`Token exchange returned invalid JSON: ${responseBody.slice(0, 100)}`));
        }
      });

      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.end();
  });
}

function collectResponse(
  res: http.IncomingMessage,
  resolve: (v: TokenResult) => void,
  reject: (e: Error) => void,
): void {
  let data = '';
  res.on('data', (chunk: string) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode && res.statusCode >= 400) {
      reject(new Error(`Token exchange failed (${res.statusCode}): ${data.slice(0, 200)}`));
      return;
    }
    try {
      resolve(JSON.parse(data));
    } catch {
      reject(new Error(`Token exchange returned invalid JSON: ${data.slice(0, 100)}`));
    }
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export function oauthGetProviders(): string[] {
  return Object.keys(PROVIDERS);
}

export function oauthInitiate(provider: string): { authUrl: string; stateId: string } {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${provider}`);

  cleanExpiredSessions();

  const { verifier, challenge } = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');
  const stateId = crypto.randomUUID();

  sessions.set(stateId, {
    provider,
    verifier,
    challenge,
    state,
    createdAt: Date.now(),
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: def.clientId,
    redirect_uri: def.redirectUri,
    scope: def.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...def.extraAuthParams,
  });

  return {
    authUrl: `${def.authUrl}?${params.toString()}`,
    stateId,
  };
}

export async function oauthComplete(
  stateId: string,
  callbackUrl: string,
): Promise<{ ok: true; provider: string; profileId: string }> {
  cleanExpiredSessions();

  const session = sessions.get(stateId);
  if (!session) {
    throw new Error('OAuth session expired or not found. Please try again.');
  }

  const def = PROVIDERS[session.provider];
  if (!def) throw new Error(`Unknown OAuth provider: ${session.provider}`);

  // Extract code and state from callback URL
  let url: URL;
  try {
    // Handle both full URLs and just query strings
    if (callbackUrl.startsWith('http')) {
      url = new URL(callbackUrl);
    } else {
      url = new URL(callbackUrl, 'http://localhost');
    }
  } catch {
    throw new Error('Invalid callback URL. Please paste the full URL from your browser address bar.');
  }

  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code) {
    throw new Error('No authorization code found in the URL. Make sure you paste the complete URL.');
  }

  if (returnedState !== session.state) {
    throw new Error('State mismatch — possible CSRF attack. Please try again.');
  }

  // Exchange code for tokens (proxy-aware for China/VPN users)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: def.clientId,
    code,
    code_verifier: session.verifier,
    redirect_uri: def.redirectUri,
  });

  const tokens = await proxyAwarePost(def.tokenUrl, body.toString());

  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error('Token exchange returned incomplete data.');
  }

  // Store in OC auth-profiles format
  const credential: OAuthCredential = {
    type: 'oauth',
    provider: session.provider,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000,
  };

  const store = readAuthStore();
  store.profiles[def.profileId] = credential;
  if (!store.version) store.version = 1;
  writeAuthStore(store);

  // Clean up session
  sessions.delete(stateId);

  return { ok: true, provider: session.provider, profileId: def.profileId };
}

export function oauthStatus(provider: string): { authenticated: boolean; profileId: string | null; expiresAt: number | null } {
  const def = PROVIDERS[provider];
  if (!def) return { authenticated: false, profileId: null, expiresAt: null };

  const store = readAuthStore();
  const cred = store.profiles[def.profileId];
  if (!cred || cred.type !== 'oauth') {
    return { authenticated: false, profileId: null, expiresAt: null };
  }

  return {
    authenticated: true,
    profileId: def.profileId,
    expiresAt: cred.expires,
  };
}

export function apiKeyStatus(provider: string): {
  configured: boolean;
  profileId: string | null;
  profileType: 'api_key' | 'oauth' | null;
} {
  const store = readAuthStore();
  const entries = Object.entries(store.profiles);
  for (const [profileId, cred] of entries) {
    if (!cred || cred.provider !== provider) continue;
    if (cred.type === 'api_key' && typeof cred.key === 'string' && cred.key.length > 0) {
      return { configured: true, profileId, profileType: 'api_key' };
    }
    if (cred.type === 'oauth' && typeof cred.access === 'string' && cred.access.length > 0) {
      return { configured: true, profileId, profileType: 'oauth' };
    }
  }
  return { configured: false, profileId: null, profileType: null };
}

export function apiKeyStatuses(providers: string[]): Record<string, {
  configured: boolean;
  profileId: string | null;
  profileType: 'api_key' | 'oauth' | null;
}> {
  const result: Record<string, {
    configured: boolean;
    profileId: string | null;
    profileType: 'api_key' | 'oauth' | null;
  }> = {};
  for (const provider of providers) {
    if (!provider) continue;
    result[provider] = apiKeyStatus(provider);
  }
  return result;
}

export function setApiKeyProfile(
  provider: string,
  apiKey: string,
  profileId?: string,
): { ok: true; provider: string; profileId: string } {
  const trimmedKey = apiKey.trim();
  if (!provider) throw new Error('provider is required');
  if (!trimmedKey) throw new Error('apiKey is required');

  const resolvedProfileId = (profileId || defaultProfileId(provider)).trim();
  const store = readAuthStore();
  if (!store.version) store.version = 1;

  store.profiles[resolvedProfileId] = {
    type: 'api_key',
    provider,
    key: trimmedKey,
  };
  ensureProviderOrder(store, provider, resolvedProfileId);
  store.lastGood = { ...(store.lastGood ?? {}), [provider]: resolvedProfileId };
  writeAuthStore(store);

  return { ok: true, provider, profileId: resolvedProfileId };
}

export function clearApiKeyProfile(
  provider: string,
  profileId?: string,
): { ok: true; provider: string; removed: string[] } {
  if (!provider) throw new Error('provider is required');

  const store = readAuthStore();
  const removed: string[] = [];
  const targetId = profileId?.trim();

  for (const [id, cred] of Object.entries(store.profiles)) {
    if (targetId && id !== targetId) continue;
    if (cred?.provider !== provider) continue;
    if (cred.type !== 'api_key') continue;
    delete store.profiles[id];
    removed.push(id);
  }

  if (removed.length > 0 && store.order && Array.isArray(store.order[provider])) {
    const nextOrder = (store.order[provider] as string[]).filter((id) => !removed.includes(id));
    store.order[provider] = nextOrder;
  }
  if (removed.length > 0 && store.lastGood?.[provider] && removed.includes(store.lastGood[provider])) {
    delete store.lastGood[provider];
  }

  writeAuthStore(store);
  return { ok: true, provider, removed };
}
