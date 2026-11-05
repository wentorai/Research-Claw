import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATCH = fs.readFileSync(path.join(ROOT, 'patches', 'openclaw@2026.9.2.patch'), 'utf8');
const LOGGER_CHUNK = path.join(ROOT, 'node_modules', 'openclaw', 'dist', 'logger-DK-iouVT.js');

describe('OpenClaw JSONL integrity patch', () => {
  it('serializes the already structured-redacted record without text-redacting JSON syntax', () => {
    expect(PATCH).toContain(
      '-\t\t\tconst line = redactSensitiveText(JSON.stringify(redactLogRecordForTransport(record)));',
    );
    expect(PATCH).toContain(
      '+\t\t\tconst line = JSON.stringify(redactLogRecordForTransport(record));',
    );
    const logger = fs.readFileSync(LOGGER_CHUNK, 'utf8');
    expect(logger).toContain(
      'const line = JSON.stringify(redactLogRecordForTransport(record));',
    );
    expect(logger).not.toContain(
      'redactSensitiveText(JSON.stringify(redactLogRecordForTransport(record)))',
    );
  });

  it('keeps structured secret redaction ahead of serialization in the installed runtime', async () => {
    const { l: redactSecrets } = await import(
      '../node_modules/openclaw/dist/redact-BtvPPfTi.js'
    ) as unknown as {
      l: <T>(value: T) => T;
    };
    const secret = ['rc-jsonl', 'integrity', 'secret', process.pid].join('-');
    const record = redactSecrets({
      message: 'provider configured',
      token: secret,
      nested: { apiKey: secret },
    });
    const line = JSON.stringify(record);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain(secret);
  });
});
