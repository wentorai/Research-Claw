#!/usr/bin/env node
/**
 * MiniMax OAuth proxy for Research-Claw.
 *
 * Why: Some users have MiniMax OAuth tokens (sk-cp-...) instead of API keys (sk-api-...).
 * OpenClaw's provider config expects a static apiKey, but does not implement an OAuth flow.
 *
 * Approach: run a local HTTP proxy and point minimax provider baseUrl to it.
 * The proxy reads the project's OpenClaw config, extracts minimax `apiKey`, and forwards
 * requests to the real MiniMax Anthropic-compatible endpoint with:
 *   Authorization: Bearer <token>
 *
 * This keeps the change fully within Research-Claw (no OpenClaw core patch).
 *
 * v2 (2026-03-26): HTTPS_PROXY tunnel, upstream timeout, response stream error
 *     handling, transient-error retry, keepAlive connection pooling.
 */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[minimax-oauth-proxy]', ...args);
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[minimax-oauth-proxy]', ...args);
}

// ---------------------------------------------------------------------------
// Config helpers (unchanged)
// ---------------------------------------------------------------------------
function resolveConfigPath() {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const __filename = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(__filename), '..');
  return path.join(repoRoot, 'config', 'openclaw.json');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadMiniMaxConfig(configPath) {
  const cfg = readJson(configPath);
  const provider = cfg?.models?.providers?.minimax ?? cfg?.models?.providers?.['minimax-cn'] ?? null;
  const apiKey = typeof provider?.apiKey === 'string' ? provider.apiKey : '';
  const upstreamFromEnv =
    typeof cfg?.env?.vars?.RC_MINIMAX_UPSTREAM_BASEURL === 'string'
      ? cfg.env.vars.RC_MINIMAX_UPSTREAM_BASEURL
      : '';
  const upstreamBaseUrl =
    upstreamFromEnv ||
    (typeof provider?.baseUrl === 'string' ? provider.baseUrl : 'https://api.minimax.io/anthropic');
  return { apiKey, upstreamBaseUrl };
}

function shouldEnableProxy(apiKey) {
  return typeof apiKey === 'string' && apiKey.startsWith('sk-cp-');
}

function sanitizeHopByHopHeaders(headers) {
  const h = { ...headers };
  delete h.connection;
  delete h['proxy-connection'];
  delete h['keep-alive'];
  delete h['transfer-encoding'];
  delete h.te;
  delete h.trailer;
  delete h.upgrade;
  return h;
}

// ---------------------------------------------------------------------------
// HTTPS proxy tunnel agent
// ---------------------------------------------------------------------------
const UPSTREAM_CONNECT_TIMEOUT_MS = 15_000; // 15s for TCP + TLS handshake
const UPSTREAM_HEADERS_TIMEOUT_MS = 30_000; // 30s for first HTTP response byte
const RETRYABLE_CODES = new Set([
  'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED',
  'EADDRNOTAVAIL', 'EPIPE', 'EAI_AGAIN',
]);
const MAX_RETRIES = 1;
const RETRY_DELAY_MS = 500;

function resolveHttpsProxy() {
  const raw =
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    warn('invalid HTTPS_PROXY URL:', raw);
    return null;
  }
}

/**
 * Create an https.Agent that tunnels through an HTTP CONNECT proxy.
 * Each new socket: HTTP CONNECT → raw TCP tunnel → TLS handshake over tunnel.
 */
function createTunnelAgent(proxyUrl) {
  return new https.Agent({
    keepAlive: true,
    maxSockets: 6,
    maxFreeSockets: 2,
    timeout: 60_000,
    createConnection(options, oncreate) {
      const host = options.host || options.hostname;
      const port = options.port || 443;
      const target = `${host}:${port}`;

      // Guard: oncreate must be called exactly once (connect/timeout/error can race)
      let settled = false;
      const settle = (err, socket) => {
        if (settled) return;
        settled = true;
        oncreate(err, socket);
      };

      const connectReq = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: 'CONNECT',
        path: target,
        headers: { Host: target },
        timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
      });

      connectReq.on('connect', (res, socket) => {
        if (settled) { socket.destroy(); return; }
        if (res.statusCode !== 200) {
          const err = new Error(`CONNECT tunnel failed: HTTP ${res.statusCode}`);
          err.code = 'ECONNREFUSED';
          socket.destroy();
          settle(err);
          return;
        }
        // Upgrade the raw TCP tunnel to TLS
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || host,
          rejectUnauthorized: options.rejectUnauthorized !== false,
        });
        // Wait for TLS handshake before handing socket to Agent
        tlsSocket.once('error', (err) => settle(err));
        tlsSocket.once('secureConnect', () => {
          tlsSocket.removeAllListeners('error'); // let Agent take over
          settle(null, tlsSocket);
        });
      });

      connectReq.on('error', (err) => settle(err));
      connectReq.on('timeout', () => {
        connectReq.destroy();
        const err = new Error('CONNECT tunnel timeout');
        err.code = 'ETIMEDOUT';
        settle(err);
      });
      connectReq.end();
    },
  });
}

/** Direct HTTPS agent with keepAlive (no proxy tunnel). */
const directAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 6,
  maxFreeSockets: 2,
  timeout: 60_000,
});

// ---------------------------------------------------------------------------
// Single upstream request attempt (returns a Promise<http.IncomingMessage>)
// ---------------------------------------------------------------------------
function attemptUpstream(method, targetUrl, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const isHttps = targetUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOpts = {
      method,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      timeout: UPSTREAM_HEADERS_TIMEOUT_MS,
    };
    // Only attach agent for HTTPS (tunnel or keepAlive)
    if (isHttps) reqOpts.agent = agent;

    const proxyReq = transport.request(reqOpts, (proxyRes) => resolve(proxyRes));

    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      const err = new Error('upstream headers timeout');
      err.code = 'ETIMEDOUT';
      reject(err);
    });

    if (body && body.length > 0) {
      proxyReq.end(body);
    } else {
      proxyReq.end();
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function start() {
  const configPath = resolveConfigPath();
  const port = Number(process.env.RC_MINIMAX_OAUTH_PROXY_PORT || 28790);
  const bind = process.env.RC_MINIMAX_OAUTH_PROXY_BIND || '127.0.0.1';

  log('config:', configPath);
  log('listening:', `http://${bind}:${port}`);

  // Resolve HTTPS proxy agent once at startup
  const proxyUrl = resolveHttpsProxy();
  const agent = proxyUrl ? createTunnelAgent(proxyUrl) : directAgent;
  if (proxyUrl) {
    log('HTTPS_PROXY:', proxyUrl.href, '(CONNECT tunnel enabled)');
  } else {
    log('HTTPS_PROXY: not set (direct connection)');
  }

  let last = loadMiniMaxConfig(configPath);

  // Periodically reload config so token updates don't require restart.
  (async () => {
    while (true) {
      await sleep(2000);
      const next = loadMiniMaxConfig(configPath);
      if (
        next &&
        (next.apiKey !== last.apiKey || next.upstreamBaseUrl !== last.upstreamBaseUrl)
      ) {
        last = next;
        log('reloaded config (minimax provider updated)');
      }
    }
  })().catch(() => {});

  // --- Stats for observability ---
  let stats = { ok: 0, fail: 0, retry: 0 };
  setInterval(() => {
    if (stats.ok + stats.fail > 0) {
      log(`stats: ok=${stats.ok} fail=${stats.fail} retry=${stats.retry}`);
      stats = { ok: 0, fail: 0, retry: 0 };
    }
  }, 60_000);

  const server = http.createServer(async (req, res) => {
    try {
      const { apiKey, upstreamBaseUrl } = last ?? loadMiniMaxConfig(configPath);
      if (!shouldEnableProxy(apiKey)) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error:
              'MiniMax OAuth proxy is disabled. Set models.providers.minimax.apiKey to an OAuth token (sk-cp-...) to enable.',
          }),
        );
        return;
      }

      const upstream = new URL(upstreamBaseUrl);
      const targetUrl = new URL(req.url || '/', upstream);

      const incomingHeaders = sanitizeHopByHopHeaders(req.headers);
      const headers = {
        ...incomingHeaders,
        host: targetUrl.host,
      };
      // Force OAuth bearer — remove any downstream auth first
      delete headers['x-api-key'];
      delete headers.authorization;
      headers.authorization = `Bearer ${apiKey}`;

      // Buffer request body so we can retry on transient failure
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);

      // Retry loop (at most MAX_RETRIES + 1 attempts)
      let lastError;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            stats.retry++;
            await sleep(RETRY_DELAY_MS);
          }

          const proxyRes = await attemptUpstream(
            req.method, targetUrl, headers, body, agent,
          );

          // --- Success: stream response back ---
          // Attach error handler BEFORE pipe() to avoid race on immediate errors
          proxyRes.on('error', (e) => {
            warn(`upstream response stream error: ${e?.message || e}`);
            // Cleanly close res so OC sees stream-end, not a hang
            if (!res.writableEnded) res.end();
          });

          const outHeaders = sanitizeHopByHopHeaders(proxyRes.headers);
          res.writeHead(proxyRes.statusCode || 502, outHeaders);
          proxyRes.pipe(res);

          stats.ok++;
          if (attempt > 0) log(`retry succeeded on attempt ${attempt + 1}`);
          return; // done
        } catch (e) {
          lastError = e;
          const code = e?.code || '';
          if (attempt < MAX_RETRIES && RETRYABLE_CODES.has(code)) {
            warn(`upstream error ${code} (${e?.message}), retrying...`);
            continue;
          }
          break; // non-retryable or out of retries
        }
      }

      // All attempts failed
      stats.fail++;
      warn(`upstream request failed: ${lastError?.message || lastError}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ ok: false, error: `Upstream request failed: ${lastError?.message || 'unknown'}` }));
      }
    } catch (e) {
      warn('handler error:', e?.message || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ ok: false, error: 'Proxy internal error' }));
      }
    }
  });

  server.listen(port, bind);
}

start().catch((e) => {
  warn('fatal:', e?.stack || e?.message || String(e));
  process.exitCode = 1;
});
