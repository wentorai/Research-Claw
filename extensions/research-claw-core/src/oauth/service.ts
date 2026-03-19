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

// Matches OC's AuthProfileStore shape (agents/auth-profiles/types.ts).
// Extra fields (lastGood, usageStats, order) are preserved via JSON round-trip
// even though TypeScript doesn't enforce them here.
interface AuthProfileStore {
  version?: number;
  profiles: Record<string, OAuthCredential>;
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

/**
 * POST with proxy support via CONNECT tunnel (no external dependencies).
 * Falls back to direct request if no proxy configured.
 */
function proxyAwarePost(
  targetUrl: string,
  body: string,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const target = new URL(targetUrl);
  const proxyUrl = resolveProxyUrl();

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body).toString(),
  };

  return new Promise((resolve, reject) => {
    const handleResponse = (res: http.IncomingMessage) => {
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
    };

    if (proxyUrl) {
      // CONNECT tunnel through HTTP proxy
      const proxy = new URL(proxyUrl);
      const connectReq = http.request({
        host: proxy.hostname,
        port: Number(proxy.port) || 7890,
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
      });

      connectReq.on('connect', (_res, socket) => {
        const req = https.request({
          method: 'POST',
          hostname: target.hostname,
          path: target.pathname + target.search,
          headers: { ...headers, Host: target.hostname },
          createConnection: () => socket,
        } as https.RequestOptions, handleResponse);
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      connectReq.on('error', (err) => {
        // Proxy failed — try direct as fallback
        directPost(target, headers, body, handleResponse, reject);
      });
      connectReq.end();
    } else {
      directPost(target, headers, body, handleResponse, reject);
    }
  });
}

function directPost(
  target: URL,
  headers: Record<string, string>,
  body: string,
  onResponse: (res: http.IncomingMessage) => void,
  onError: (err: Error) => void,
): void {
  const req = https.request({
    method: 'POST',
    hostname: target.hostname,
    port: target.port || 443,
    path: target.pathname + target.search,
    headers: { ...headers, Host: target.hostname },
  }, onResponse);
  req.on('error', onError);
  req.write(body);
  req.end();
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
