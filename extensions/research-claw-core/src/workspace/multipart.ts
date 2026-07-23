/**
 * Streaming multipart parser for POST /rc/upload.
 *
 * The file part is streamed to a temp file under `<workspaceRoot>/.uploads-tmp/`
 * (same filesystem as the workspace, so the final move is an atomic rename) —
 * memory stays O(1) regardless of upload size. Small text fields (destination,
 * onConflict) are buffered. The temp file lives in a dedicated staging dir
 * rather than the destination's parent because multipart field order is not
 * guaranteed: the file part may arrive before the destination field.
 *
 * Temp names follow save()'s `.${uuid}.tmp` convention, which the workspace's
 * default .gitignore already excludes via `*.tmp`.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';

/** Thrown when the request exceeds maxSize. The message doubles as the wire
 *  contract: the /rc/upload handler maps messages containing UPLOAD_TOO_LARGE
 *  to HTTP 413. */
export class UploadTooLargeError extends Error {
  override readonly name = 'UploadTooLargeError';
  constructor() {
    super('UPLOAD_TOO_LARGE');
  }
}

export interface StreamedUploadFile {
  filename: string;
  mimeType: string;
  /** Absolute path of the temp file holding the uploaded bytes. */
  tmpPath: string;
  size: number;
}

export interface StreamedUpload {
  file: StreamedUploadFile | null;
  destination: string;
  onConflict: string;
}

/** Small-field and per-part-header caps — these are text fields, never files. */
const MAX_FIELD_BYTES = 16 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

type State = 'preamble' | 'headers' | 'fileBody' | 'fieldBody' | 'done';

/**
 * Parse a multipart/form-data request, streaming the `file` part to a temp
 * file under `tmpDir`. `maxSize` caps the TOTAL request bytes (0 = unlimited)
 * with a per-chunk early abort. On any failure the temp file is removed.
 */
export async function parseMultipartToTemp(
  req: IncomingMessage,
  opts: { maxSize: number; tmpDir: string },
): Promise<StreamedUpload> {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=(.+?)(?:;|$)/);
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }
  let boundary = boundaryMatch[1];
  if (boundary.startsWith('"') && boundary.endsWith('"')) {
    boundary = boundary.slice(1, -1);
  }

  // Between parts the delimiter is preceded by CRLF; the very first one is not.
  const firstDelim = Buffer.from(`--${boundary}`);
  const delim = Buffer.from(`\r\n--${boundary}`);
  const headerSep = Buffer.from('\r\n\r\n');

  let state: State = 'preamble';
  let pending: Buffer = Buffer.alloc(0);
  let totalSize = 0;

  // Current-part context
  let partName = '';
  let partFilename: string | null = null;
  let partMime = 'application/octet-stream';
  let fieldValue: Buffer = Buffer.alloc(0);
  let fileStream: fs.WriteStream | null = null;
  // Persistent error sentinel: WriteStream can emit 'error' (ENOSPC, EACCES)
  // asynchronously even when write() returned true — without a listener that
  // would crash the process. The sentinel is checked at every write/finish.
  let fileStreamError: Error | null = null;
  let fileBytes = 0;

  const result: StreamedUpload = { file: null, destination: '', onConflict: '' };

  const cleanup = async () => {
    if (fileStream) {
      const s = fileStream;
      fileStream = null;
      s.destroy();
      try {
        await fsp.unlink(s.path as string);
      } catch {
        // Already gone — fine.
      }
    }
    if (result.file) {
      try {
        await fsp.unlink(result.file.tmpPath);
      } catch {
        // Already gone — fine.
      }
      result.file = null;
    }
  };

  const writeToFile = async (buf: Buffer) => {
    if (!fileStream || buf.length === 0) return;
    if (fileStreamError) throw fileStreamError;
    fileBytes += buf.length;
    if (!fileStream.write(buf)) {
      // once() rejects if 'error' fires before 'drain'.
      await once(fileStream, 'drain');
    }
    if (fileStreamError) throw fileStreamError;
  };

  /** Close out the part we were reading when its trailing delimiter arrives. */
  const finishPart = async () => {
    if (state === 'fileBody' && fileStream) {
      const s = fileStream;
      fileStream = null;
      // A destroyed stream (prior async error) emits 'close' without re-emitting
      // 'error' — the sentinel is the only reliable signal that data was lost.
      if (fileStreamError) throw fileStreamError;
      s.end();
      await once(s, 'close');
      if (fileStreamError) throw fileStreamError;
      // Only the LAST `file` part wins (matches the previous buffered parser).
      if (result.file) {
        try {
          await fsp.unlink(result.file.tmpPath);
        } catch {
          // Already gone — fine.
        }
      }
      result.file = {
        filename: partFilename ?? 'file',
        mimeType: partMime,
        tmpPath: s.path as string,
        size: fileBytes,
      };
    } else if (state === 'fieldBody') {
      const value = fieldValue.toString('utf-8').trim();
      if (partName === 'destination') result.destination = value;
      else if (partName === 'onConflict') result.onConflict = value;
      // Unknown fields are ignored (wire compatibility).
    }
  };

  /** Consume `pending` as far as possible; returns when more input is needed. */
  const drainPending = async (): Promise<void> => {
    while (true) {
      if (state === 'preamble') {
        const idx = pending.indexOf(firstDelim);
        if (idx === -1) {
          // Keep only a potential partial-delimiter tail.
          if (pending.length > firstDelim.length) {
            pending = pending.subarray(pending.length - firstDelim.length);
          }
          return;
        }
        pending = pending.subarray(idx + firstDelim.length);
        state = 'headers';
        continue;
      }

      if (state === 'headers') {
        // After a delimiter: `--` means epilogue; otherwise a CRLF then headers.
        if (pending.length < 2) return;
        if (pending[0] === 0x2d && pending[1] === 0x2d) {
          state = 'done';
          return;
        }
        const sepIdx = pending.indexOf(headerSep);
        if (sepIdx === -1) {
          if (pending.length > MAX_HEADER_BYTES) throw new Error('Multipart header too large');
          return;
        }
        const headers = pending.subarray(0, sepIdx).toString('utf-8').replace(/^\r\n/, '');
        pending = pending.subarray(sepIdx + headerSep.length);

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        const ctMatch = headers.match(/Content-Type:\s*(.+?)(?:\r\n|$)/i);
        partName = nameMatch?.[1] ?? '';
        partFilename = filenameMatch?.[1] ?? null;
        partMime = ctMatch?.[1]?.trim() ?? 'application/octet-stream';
        fieldValue = Buffer.alloc(0);
        fileBytes = 0;

        if (partName === 'file' && partFilename) {
          await fsp.mkdir(opts.tmpDir, { recursive: true });
          fileStreamError = null;
          fileStream = fs.createWriteStream(path.join(opts.tmpDir, `.${randomUUID()}.tmp`));
          fileStream.on('error', (err) => {
            fileStreamError = err;
          });
          state = 'fileBody';
        } else {
          state = 'fieldBody';
        }
        continue;
      }

      if (state === 'fileBody' || state === 'fieldBody') {
        const idx = pending.indexOf(delim);
        if (idx === -1) {
          // Flush everything except a tail that could be a split delimiter.
          const keep = delim.length - 1;
          if (pending.length > keep) {
            const flush = pending.subarray(0, pending.length - keep);
            pending = pending.subarray(pending.length - keep);
            if (state === 'fileBody') {
              await writeToFile(flush);
            } else {
              fieldValue = Buffer.concat([fieldValue, flush]);
              if (fieldValue.length > MAX_FIELD_BYTES) throw new Error('Multipart field too large');
            }
          }
          return;
        }
        const body = pending.subarray(0, idx);
        pending = pending.subarray(idx + delim.length);
        if (state === 'fileBody') {
          await writeToFile(body);
        } else {
          fieldValue = Buffer.concat([fieldValue, body]);
        }
        await finishPart();
        state = 'headers';
        continue;
      }

      return; // done
    }
  };

  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      totalSize += chunk.length;
      if (opts.maxSize > 0 && totalSize > opts.maxSize) {
        req.destroy();
        throw new UploadTooLargeError();
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      await drainPending();
      // drainPending mutates `state` through a closure — widen for the check.
      if ((state as State) === 'done') break;
    }
    if ((state as State) !== 'done') {
      throw new Error('Malformed multipart body (missing closing boundary)');
    }
    return result;
  } catch (err) {
    await cleanup();
    throw err;
  }
}
