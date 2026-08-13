import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PATCH = fs.readFileSync(path.join(ROOT, 'patches', 'openclaw@2026.6.1.patch'), 'utf8');

describe('OpenClaw JSONL integrity patch', () => {
  it('serializes the already structured-redacted record without text-redacting JSON syntax', () => {
    expect(PATCH).toContain(
      '+\t\t\tconst payload = `${JSON.stringify(redactLogRecordForTransport(record))}\\n`;',
    );
    expect(PATCH).toContain(
      '-\t\t\tconst payload = `${redactSensitiveText(JSON.stringify(redactLogRecordForTransport(record)))}\\n`;',
    );
  });

  it('keeps structured secret redaction ahead of serialization in the installed runtime', async () => {
    const internalRedactor = await import('../node_modules/openclaw/dist/redact-B8nIzFk3.js') as unknown as {
      r: <T>(value: T) => T;
    };
    const secret = 'rc-jsonl-integrity-secret-123456789';
    const record = internalRedactor.r({
      message: 'provider configured',
      token: secret,
      nested: { apiKey: secret },
    });
    const line = JSON.stringify(record);
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain(secret);
  });
});
