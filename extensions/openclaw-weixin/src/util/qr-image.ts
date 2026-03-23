/**
 * QR code → PNG data URL generator.
 * Uses qrcode-terminal's vendored QRCode module for matrix generation
 * and a minimal PNG encoder (node:zlib only, no native deps).
 * Adapted from openclaw/src/web/qr-image.ts + openclaw/src/media/png-encode.ts.
 */
import { deflateSync } from "node:zlib";

// @ts-expect-error — vendor module has no types
import QRCodeModule from "qrcode-terminal/vendor/QRCode/index.js";
// @ts-expect-error — vendor module has no types
import QRErrorCorrectLevelModule from "qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js";

type QRCodeInstance = {
  addData: (data: string) => void;
  make: () => void;
  getModuleCount: () => number;
  isDark: (row: number, col: number) => boolean;
};
type QRCodeConstructor = new (typeNumber: number, errorCorrectLevel: unknown) => QRCodeInstance;

const QRCode = QRCodeModule as QRCodeConstructor;
const QRErrorCorrectLevel = QRErrorCorrectLevelModule;

// ── Minimal PNG encoder ──────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePngRgba(buffer: Buffer, width: number, height: number): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    const rawOffset = row * (stride + 1);
    raw[rawOffset] = 0;
    buffer.copy(raw, rawOffset + 1, row * stride, row * stride + stride);
  }
  const compressed = deflateSync(raw);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── QR → data URL ────────────────────────────────────────────────────────

export function renderQrDataUrl(
  input: string,
  opts: { scale?: number; marginModules?: number } = {},
): string {
  const { scale = 6, marginModules = 4 } = opts;
  const qr = new QRCode(-1, QRErrorCorrectLevel.L);
  qr.addData(input);
  qr.make();
  const modules = qr.getModuleCount();
  const size = (modules + marginModules * 2) * scale;

  const buf = Buffer.alloc(size * size * 4, 255);
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      if (!qr.isDark(row, col)) continue;
      const startX = (col + marginModules) * scale;
      const startY = (row + marginModules) * scale;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const idx = ((startY + y) * size + (startX + x)) * 4;
          buf[idx] = 0;
          buf[idx + 1] = 0;
          buf[idx + 2] = 0;
          buf[idx + 3] = 255;
        }
      }
    }
  }

  const png = encodePngRgba(buf, size, size);
  return `data:image/png;base64,${png.toString("base64")}`;
}
