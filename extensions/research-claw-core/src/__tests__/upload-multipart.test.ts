/**
 * parseMultipartUpload — wire-format tests for POST /rc/upload.
 *
 * Feeds synthetic multipart bodies through a fake IncomingMessage to pin:
 * - file + destination parsing (binary-safe)
 * - the new onConflict field
 * - unknown extra fields are ignored (backward/forward wire compatibility)
 * - maxSize=0 disables the cap; a positive cap aborts per-chunk with
 *   UPLOAD_TOO_LARGE and destroys the request
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { parseMultipartUpload } from '../../index.js';

const BOUNDARY = '----vitestBoundary42';

interface Part {
  name: string;
  value: Buffer | string;
  filename?: string;
  contentType?: string;
}

function buildMultipartBody(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const disposition = p.filename
      ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"`
      : `Content-Disposition: form-data; name="${p.name}"`;
    const headers = [disposition];
    if (p.contentType) headers.push(`Content-Type: ${p.contentType}`);
    chunks.push(Buffer.from(`--${BOUNDARY}\r\n${headers.join('\r\n')}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

/** Wrap a body in a fake IncomingMessage, optionally split into chunks. */
function makeRequest(body: Buffer, chunkSize = body.length): IncomingMessage {
  const chunks: Buffer[] = [];
  for (let i = 0; i < body.length; i += chunkSize) {
    chunks.push(body.subarray(i, Math.min(i + chunkSize, body.length)));
  }
  const req = Readable.from(chunks) as unknown as IncomingMessage;
  (req as { headers: Record<string, string> }).headers = {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
  };
  return req;
}

describe('parseMultipartUpload', () => {
  it('parses file bytes and destination (binary-safe)', async () => {
    // Payload contains CRLFs and boundary-like bytes to exercise binary safety.
    const payload = Buffer.concat([
      Buffer.from('PDF\r\n\r\n--not-a-boundary\r\n'),
      Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]),
    ]);
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', value: payload },
        { name: 'destination', value: 'sources/chat' },
      ]),
    );
    const { file, destination, onConflict } = await parseMultipartUpload(req, 0);
    expect(destination).toBe('sources/chat');
    expect(onConflict).toBe('');
    expect(file?.filename).toBe('paper.pdf');
    expect(file?.mimeType).toBe('application/pdf');
    expect(file?.data.equals(payload)).toBe(true);
  });

  it('parses the onConflict field', async () => {
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'a.txt', value: 'A' },
        { name: 'destination', value: 'sources' },
        { name: 'onConflict', value: 'rename' },
      ]),
    );
    const { onConflict } = await parseMultipartUpload(req, 0);
    expect(onConflict).toBe('rename');
  });

  it('ignores unknown extra fields (wire compatibility)', async () => {
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'a.txt', value: 'A' },
        { name: 'destination', value: 'sources' },
        { name: 'futureField', value: 'whatever' },
      ]),
    );
    const { file, destination } = await parseMultipartUpload(req, 0);
    expect(file?.data.toString()).toBe('A');
    expect(destination).toBe('sources');
  });

  it('maxSize=0 disables the cap entirely', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const req = makeRequest(
      buildMultipartBody([{ name: 'file', filename: 'big.bin', value: big }]),
      64 * 1024,
    );
    const { file } = await parseMultipartUpload(req, 0);
    expect(file?.data.length).toBe(big.length);
  });

  it('a positive cap aborts per-chunk with UPLOAD_TOO_LARGE and destroys the request', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const req = makeRequest(
      buildMultipartBody([{ name: 'file', filename: 'big.bin', value: big }]),
      64 * 1024,
    );
    await expect(parseMultipartUpload(req, 256 * 1024)).rejects.toThrow('UPLOAD_TOO_LARGE');
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});
