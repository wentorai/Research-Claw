/**
 * parseMultipartToTemp — wire-format tests for the streaming upload parser.
 *
 * Feeds synthetic multipart bodies through a fake IncomingMessage and pins:
 * - file bytes stream to a temp file byte-identically (binary-safe)
 * - chunk-boundary robustness (whole-body, 64KB, 7B, 1B splits straddle the
 *   delimiter and headers)
 * - field-order independence (file part before destination)
 * - the onConflict field + unknown extra fields ignored (wire compatibility)
 * - maxSize: 0 = unlimited; positive cap aborts per-chunk with
 *   UPLOAD_TOO_LARGE, destroys the request, and removes the temp file
 * - client abort mid-stream removes the temp file
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';

import { parseMultipartToTemp, UploadTooLargeError } from '../workspace/multipart.js';

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

// Payload with CRLFs and boundary-like bytes to exercise binary safety.
const BINARY_PAYLOAD = Buffer.concat([
  Buffer.from('PDF\r\n\r\n--not-a-boundary\r\n'),
  Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]),
]);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-multipart-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function tmpDirEntries(): Promise<string[]> {
  try {
    return await fsp.readdir(tmpDir);
  } catch {
    return [];
  }
}

describe('parseMultipartToTemp', () => {
  it('streams file bytes to a temp file byte-identically and parses fields', async () => {
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'paper.pdf', contentType: 'application/pdf', value: BINARY_PAYLOAD },
        { name: 'destination', value: 'sources/chat' },
        { name: 'onConflict', value: 'rename' },
      ]),
    );
    const { file, destination, onConflict } = await parseMultipartToTemp(req, { maxSize: 0, tmpDir });
    expect(destination).toBe('sources/chat');
    expect(onConflict).toBe('rename');
    expect(file?.filename).toBe('paper.pdf');
    expect(file?.mimeType).toBe('application/pdf');
    expect(file?.size).toBe(BINARY_PAYLOAD.length);
    const onDisk = await fsp.readFile(file!.tmpPath);
    expect(onDisk.equals(BINARY_PAYLOAD)).toBe(true);
  });

  it.each([64 * 1024, 7, 1])('is byte-identical when the body arrives in %d-byte chunks', async (chunkSize) => {
    const body = buildMultipartBody([
      { name: 'destination', value: 'sources' },
      { name: 'file', filename: 'a.bin', value: BINARY_PAYLOAD },
    ]);
    const { file } = await parseMultipartToTemp(makeRequest(body, chunkSize), { maxSize: 0, tmpDir });
    const onDisk = await fsp.readFile(file!.tmpPath);
    expect(onDisk.equals(BINARY_PAYLOAD)).toBe(true);
  });

  it('is field-order independent (file part BEFORE destination)', async () => {
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'a.txt', value: 'A' },
        { name: 'destination', value: 'notes' },
      ]),
      16,
    );
    const { file, destination } = await parseMultipartToTemp(req, { maxSize: 0, tmpDir });
    expect(destination).toBe('notes');
    expect((await fsp.readFile(file!.tmpPath)).toString()).toBe('A');
  });

  it('ignores unknown extra fields (wire compatibility)', async () => {
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'a.txt', value: 'A' },
        { name: 'destination', value: 'sources' },
        { name: 'futureField', value: 'whatever' },
      ]),
    );
    const { file, destination } = await parseMultipartToTemp(req, { maxSize: 0, tmpDir });
    expect(destination).toBe('sources');
    expect((await fsp.readFile(file!.tmpPath)).toString()).toBe('A');
  });

  it('maxSize=0 disables the cap entirely', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const req = makeRequest(buildMultipartBody([{ name: 'file', filename: 'big.bin', value: big }]), 64 * 1024);
    const { file } = await parseMultipartToTemp(req, { maxSize: 0, tmpDir });
    expect(file?.size).toBe(big.length);
  });

  it('a positive cap aborts per-chunk with UPLOAD_TOO_LARGE, destroys the request, removes the temp file', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x61);
    const req = makeRequest(buildMultipartBody([{ name: 'file', filename: 'big.bin', value: big }]), 64 * 1024);
    await expect(parseMultipartToTemp(req, { maxSize: 256 * 1024, tmpDir })).rejects.toThrow(UploadTooLargeError);
    expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(await tmpDirEntries()).toEqual([]);
  });

  it('client abort mid-stream rejects and removes the temp file', async () => {
    const big = Buffer.alloc(512 * 1024, 0x61);
    const body = buildMultipartBody([{ name: 'file', filename: 'big.bin', value: big }]);
    // Stream that emits half the body then errors (connection reset).
    const half = body.subarray(0, Math.floor(body.length / 2));
    const req = new Readable({
      read() {
        this.push(half);
        this.destroy(new Error('ECONNRESET'));
      },
    }) as unknown as IncomingMessage;
    (req as { headers: Record<string, string> }).headers = {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    };
    await expect(parseMultipartToTemp(req, { maxSize: 0, tmpDir })).rejects.toThrow();
    expect(await tmpDirEntries()).toEqual([]);
  });

  it('write-stream failure (EACCES) rejects instead of crashing, leaves no residue', async () => {
    // Read-only staging dir → createWriteStream emits an async 'error' (EACCES)
    // while write() calls keep returning true — the persistent sentinel must
    // surface it as a rejection, never as an uncaught exception.
    fs.chmodSync(tmpDir, 0o555);
    try {
      const req = makeRequest(
        buildMultipartBody([{ name: 'file', filename: 'a.bin', value: Buffer.alloc(1024, 0x61) }]),
        64,
      );
      await expect(parseMultipartToTemp(req, { maxSize: 0, tmpDir })).rejects.toThrow();
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }
    expect(await tmpDirEntries()).toEqual([]);
  });

  it('first-chunk abort/truncation leaves ZERO residue deterministically (open-vs-unlink race)', async () => {
    // The leak the integration review found: cleanup unlinked while the
    // WriteStream open() was still in flight, orphaning the .tmp once open
    // completed. Loop many times over the exact single-chunk cadence that
    // exposed the race; every run must clean up.
    for (let i = 0; i < 30; i++) {
      const body = buildMultipartBody([{ name: 'file', filename: 'x.bin', value: Buffer.alloc(2048, 0x61) }]);
      // Emit only the header + first byte of the body, then reset the connection.
      const cut = body.indexOf(Buffer.from('\r\n\r\n')) + 5;
      const head = body.subarray(0, cut);
      const req = new Readable({
        read() {
          this.push(head);
          this.destroy(new Error('ECONNRESET'));
        },
      }) as unknown as IncomingMessage;
      (req as { headers: Record<string, string> }).headers = {
        'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      };
      await expect(parseMultipartToTemp(req, { maxSize: 0, tmpDir })).rejects.toThrow();
    }
    expect(await tmpDirEntries()).toEqual([]);
  });

  it('abort AFTER several successful writes cleans up without hanging (live-stream cleanup path)', async () => {
    // maxSize trips only after many chunks have already been written to the open
    // stream — cleanup() must destroy the live (non-closed) stream, await close,
    // and unlink, all without hanging. Bounded by the test runner timeout.
    const big = Buffer.alloc(1024 * 1024, 0x61);
    const req = makeRequest(buildMultipartBody([{ name: 'file', filename: 'big.bin', value: big }]), 32 * 1024);
    await expect(parseMultipartToTemp(req, { maxSize: 512 * 1024, tmpDir })).rejects.toThrow(/TOO_LARGE/);
    expect(await tmpDirEntries()).toEqual([]);
  });

  it('two file parts: last one wins and the first temp file is removed', async () => {
    const req = makeRequest(
      buildMultipartBody([
        { name: 'file', filename: 'first.txt', value: 'FIRST' },
        { name: 'file', filename: 'second.txt', value: 'SECOND' },
      ]),
    );
    const { file } = await parseMultipartToTemp(req, { maxSize: 0, tmpDir });
    expect(file?.filename).toBe('second.txt');
    expect((await fsp.readFile(file!.tmpPath)).toString()).toBe('SECOND');
    expect(await tmpDirEntries()).toHaveLength(1); // first tmp unlinked
  });

  it('empty file part yields a zero-byte temp file', async () => {
    const req = makeRequest(
      buildMultipartBody([{ name: 'file', filename: 'empty.bin', value: Buffer.alloc(0) }]),
    );
    const { file } = await parseMultipartToTemp(req, { maxSize: 0, tmpDir });
    expect(file?.size).toBe(0);
    expect((await fsp.readFile(file!.tmpPath)).length).toBe(0);
  });

  it('truncated body (no closing boundary) rejects and removes the temp file', async () => {
    const body = buildMultipartBody([{ name: 'file', filename: 'a.bin', value: Buffer.alloc(1024, 0x61) }]);
    const truncated = body.subarray(0, body.length - 40);
    await expect(parseMultipartToTemp(makeRequest(truncated, 128), { maxSize: 0, tmpDir })).rejects.toThrow(
      /closing boundary/,
    );
    expect(await tmpDirEntries()).toEqual([]);
  });
});
