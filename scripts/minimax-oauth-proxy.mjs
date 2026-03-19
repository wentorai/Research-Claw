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
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[minimax-oauth-proxy]', ...args);
}

function warn(...args) {
  // eslint-disable-next-line no-console
  console.warn('[minimax-oauth-proxy]', ...args);
}

function resolveConfigPath() {
  // scripts/run.sh sets OPENCLAW_CONFIG_PATH
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  // fallback to repo-relative config/openclaw.json
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

  // When we re-point baseUrl to this proxy, we preserve the original in `upstreamBaseUrl`.
  const upstreamBaseUrl =
    typeof provider?.upstreamBaseUrl === 'string'
      ? provider.upstreamBaseUrl
      : (typeof provider?.baseUrl === 'string' ? provider.baseUrl : 'https://api.minimax.io/anthropic');

  return { apiKey, upstreamBaseUrl };
}

function shouldEnableProxy(apiKey) {
  // We only need this proxy for OAuth-ish tokens.
  return typeof apiKey === 'string' && apiKey.startsWith('sk-cp-');
}

function sanitizeHopByHopHeaders(headers) {
  // RFC 7230 hop-by-hop headers: remove to avoid proxy issues
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

async function start() {
  const configPath = resolveConfigPath();
  const port = Number(process.env.RC_MINIMAX_OAUTH_PROXY_PORT || 28790);
  const bind = process.env.RC_MINIMAX_OAUTH_PROXY_BIND || '127.0.0.1';

  log('config:', configPath);
  log('listening:', `http://${bind}:${port}`);

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

      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const incomingHeaders = sanitizeHopByHopHeaders(req.headers);
      const headers = {
        ...incomingHeaders,
        host: targetUrl.host,
        // Force OAuth bearer
        authorization: `Bearer ${apiKey}`,
      };
      // Avoid leaking any downstream auth header
      delete headers['x-api-key'];
      delete headers['x-api-key'.toLowerCase()];
      delete headers['authorization'];
      headers.authorization = `Bearer ${apiKey}`;

      const proxyReq = transport.request(
        {
          method: req.method,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (isHttps ? 443 : 80),
          path: `${targetUrl.pathname}${targetUrl.search}`,
          headers,
        },
        (proxyRes) => {
          const outHeaders = sanitizeHopByHopHeaders(proxyRes.headers);
          res.writeHead(proxyRes.statusCode || 502, outHeaders);

          // Stream through (supports SSE/chunked)
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('error', (e) => {
        warn('upstream request error:', e?.message || e);
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ ok: false, error: 'Upstream request failed' }));
      });

      // Pipe request body
      if (req.readable) {
        req.pipe(proxyReq);
      } else {
        proxyReq.end();
      }
    } catch (e) {
      warn('handler error:', e?.message || e);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: 'Proxy internal error' }));
    }
  });

  server.listen(port, bind);
}

start().catch((e) => {
  warn('fatal:', e?.stack || e?.message || String(e));
  process.exitCode = 1;
});

