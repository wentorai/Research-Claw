#!/usr/bin/env node

import fs from 'node:fs/promises';
import process from 'node:process';

const REDACTED = '***REDACTED***';
const [mode, source, destination] = process.argv.slice(2);
if (!['json', 'proxy', 'text'].includes(mode) || !source || !destination) {
  process.stderr.write('Usage: diag-redact.mjs <json|proxy|text> <source|-> <destination|->\n');
  process.exit(2);
}
if (mode === 'proxy') {
  try {
    await writeOutput(destination, redactProxyEndpoint(await readInput(source)));
    process.exit(0);
  } catch (error) {
    process.stderr.write(`proxy redaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

function normalizedKeyParts(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SENSITIVE_KEY_PARTS = new Set([
  'apikey',
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'dsn',
  'key',
  'passphrase',
  'passwd',
  'password',
  'pat',
  'secret',
  'token',
  'webhook',
]);

function isSensitiveKey(key) {
  const parts = normalizedKeyParts(key);
  return parts.some(part => SENSITIVE_KEY_PARTS.has(part)) ||
    (parts.includes('api') && parts.includes('key'));
}

/**
 * OpenClaw's own redactor is the first of two nets. Losing it — a moved module,
 * a renamed export, a bundle built without OpenClaw — silently narrows what this
 * bundle scrubs, and the bundle is what users are told to send us. Degrading is
 * still the right call (the local rules below stay active), but it must be said
 * out loud on stderr rather than passing for a full-strength redaction.
 */
const OPENCLAW_LAYER_UNAVAILABLE = 'openclaw redaction layer unavailable';
let openClawRedact = value => value;
try {
  const module = await import('openclaw/plugin-sdk/logging-core');
  if (typeof module.redactSensitiveText === 'function') {
    openClawRedact = value => module.redactSensitiveText(value, { mode: 'tools' });
  } else {
    process.stderr.write(
      `${OPENCLAW_LAYER_UNAVAILABLE}: redactSensitiveText is not exported; local rules only\n`,
    );
  }
} catch (error) {
  process.stderr.write(
    `${OPENCLAW_LAYER_UNAVAILABLE}: ${error instanceof Error ? error.message : String(error)}; local rules only\n`,
  );
}

function redactText(value) {
  return openClawRedact(String(value))
    .replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/giu,
      '$1***@',
    )
    .replace(
      /(^|[\r\n])(\s*(?:set-)?cookie\s*:\s*)[^\r\n]*/giu,
      '$1$2***',
    )
    // Log lines pack headers into one structured blob, so a Cookie header is
    // frequently mid-line. Consume the whole cookie-pair list up to the
    // enclosing bracket/quote rather than stopping at the first ';'.
    .replace(
      /\b((?:set-)?cookie\s*:\s*)[^\r\n)\]}"']*/giu,
      '$1***',
    )
    // Scheme-less proxy userinfo (HTTPS_PROXY=user:pass@host:port) carries the
    // same credential as the URL form but has no '://' for the rule above.
    .replace(
      /\b([\w.~%+-]+):([^@\s/:]{3,})@((?:[\w-]+\.)+[\w-]+|\d{1,3}(?:\.\d{1,3}){3}|localhost)(?=[:/\s"',]|$)/giu,
      '$1:***@$3',
    )
    .replace(
      /https?:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/giu,
      'https://hooks.slack.com/services/***',
    )
    .replace(
      /https?:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^\s"'<>]+/giu,
      'https://discord.com/api/webhooks/***',
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|auth|code|credential|key|pass(?:word|phrase)?|secret|signature|token)=)[^&#\s"']+/giu,
      '$1***',
    )
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|authorization|bearer|credential|password|passphrase|secret|token)\s*[:=]\s*)(?!\$\{)[^\s,;}"']+/giu,
      '$1***',
    )
    .replace(PEM_BLOCK, REDACTED);
}

const PEM_LABEL = '(?:[A-Z0-9]+ )*PRIVATE KEY';
const PEM_BLOCK = new RegExp(
  `-----BEGIN ${PEM_LABEL}-----[\\s\\S]*?-----END ${PEM_LABEL}-----`,
  'gu',
);
const PEM_HEAD_ONLY = new RegExp(`-----BEGIN ${PEM_LABEL}-----[\\s\\S]*$`, 'gu');
const PEM_TAIL_ONLY = new RegExp(
  `(^|\\n)(?:[A-Za-z0-9+/=]{16,}[ \\t]*\\n)+(-----END ${PEM_LABEL}-----)`,
  'gu',
);

/**
 * PEM bodies span lines, so they must be folded before any per-line pass sees
 * them. Log tails are cut at an arbitrary line, so a bundle can also contain a
 * key with only its BEGIN or only its END marker; both halves are redacted
 * fail-closed.
 */
function redactPemBlocks(input) {
  return input
    .replace(PEM_BLOCK, REDACTED)
    .replace(PEM_TAIL_ONLY, `$1${REDACTED}\n$2`)
    .replace(PEM_HEAD_ONLY, REDACTED);
}

function redactArray(values) {
  const output = [];
  let redactNext = false;
  for (const entry of values) {
    if (redactNext) {
      output.push(REDACTED);
      redactNext = false;
      continue;
    }
    if (typeof entry === 'string') {
      const equalIndex = entry.indexOf('=');
      const flag = equalIndex >= 0 ? entry.slice(0, equalIndex) : entry;
      if (/^-{1,2}/u.test(flag) && isSensitiveKey(flag.replace(/^-+/u, ''))) {
        if (equalIndex >= 0) {
          output.push(`${flag}=${REDACTED}`);
        } else {
          output.push(entry);
          redactNext = true;
        }
        continue;
      }
    }
    output.push(redactStructured(entry));
  }
  return output;
}

function redactStructured(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return redactArray(value);
  if (value === null || typeof value !== 'object') return value;
  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactStructured(nested);
  }
  return output;
}

function redactTextWithJsonLines(input) {
  return redactPemBlocks(input)
    .split('\n')
    .map(line => {
      if (!line.trim().startsWith('{') && !line.trim().startsWith('[')) {
        return redactText(line);
      }
      try {
        return JSON.stringify(redactStructured(JSON.parse(line)));
      } catch {
        return redactText(line);
      }
    })
    .join('\n');
}

async function readInput(source) {
  if (source !== '-') return await fs.readFile(source, 'utf8');
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeOutput(destination, content) {
  if (destination === '-') {
    process.stdout.write(content);
    return;
  }
  await fs.writeFile(destination, content, { mode: 0o600 });
}

function redactProxyEndpoint(raw) {
  try {
    const url = new URL(raw.trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return '[configured]';
  }
}

try {
  const input = await readInput(source);
  let output;
  if (mode === 'json') {
    try {
      output = `${JSON.stringify(redactStructured(JSON.parse(input)), null, 2)}\n`;
    } catch {
      output = `${JSON.stringify({ error: 'unreadable JSON omitted from diagnostic bundle' }, null, 2)}\n`;
    }
  } else {
    output = redactTextWithJsonLines(input);
  }
  await writeOutput(destination, output);
} catch (error) {
  process.stderr.write(`redaction failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
