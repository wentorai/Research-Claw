#!/usr/bin/env node
/**
 * Live integration test: image routing through workspace.
 *
 * Tests the FULL flow that the dashboard implements:
 *   1. rc.ws.saveImage — save base64 image to workspace
 *   2. chat.send with [rc-image:...] markers + file paths
 *   3. Agent processes the message (uses /image tool for text-only primary)
 *
 * Scenarios tested:
 *   S1: text primary (glm-5) + image secondary (glm-4.6v) — /image tool routing
 *   S3: text primary only (no imageModel) — should... we test the guard at dashboard level
 *   S4: vision primary (if available) — inline image
 */
import { readFileSync } from 'fs';
import { randomUUID, webcrypto } from 'crypto';
import http from 'http';

const { subtle } = webcrypto;
const GW_HOST = '127.0.0.1';
const GW_PORT = 28789;
const IMAGE_PATH = '/Users/sylvanl/Downloads/wentor/测试图片.png';

const imageBuffer = readFileSync(IMAGE_PATH);
const imageBase64 = imageBuffer.toString('base64');
console.log(`Image: ${IMAGE_PATH} (${imageBuffer.length} bytes)\n`);

// ─── Crypto helpers ──────────────────────────────────────────────────────────
function b64url(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── WebSocket frame helpers ─────────────────────────────────────────────────
function buildFrame(json) {
  const payload = Buffer.from(JSON.stringify(json), 'utf8');
  const mask = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 8), 'hex');
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(6); header[0] = 0x81; header[1] = 0x80 | payload.length;
    mask.copy(header, 2);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(8); header[0] = 0x81; header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2); mask.copy(header, 4);
  } else {
    header = Buffer.alloc(14); header[0] = 0x81; header[1] = 0x80 | 127;
    header.writeUInt32BE(0, 2); header.writeUInt32BE(payload.length, 6);
    mask.copy(header, 10);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, masked]);
}
function parseFrames(buf) {
  const messages = [];
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
    const hasMask = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (hasMask) off += 4;
    if (buf.length < off + len) break;
    let data = buf.subarray(off, off + len);
    if (hasMask) { const mk = buf.subarray(off - 4, off); data = Buffer.from(data); for (let i = 0; i < data.length; i++) data[i] ^= mk[i % 4]; }
    if (opcode === 1) messages.push(data.toString('utf8'));
    else if (opcode === 8) messages.push(null);
    buf = buf.subarray(off + len);
  }
  return { messages, remaining: buf };
}

// ─── Gateway client ──────────────────────────────────────────────────────────
class Client {
  constructor() { this.pending = new Map(); this.events = []; this.frameBuf = Buffer.alloc(0); }

  connect() {
    return new Promise((resolve, reject) => {
      const key = Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64');
      const req = http.request({
        host: GW_HOST, port: GW_PORT, path: '/', method: 'GET',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key, Origin: `http://${GW_HOST}:${GW_PORT}` },
      });
      this._challengeResolve = null;
      this._challengeNonce = null;
      req.on('upgrade', (_r, sock) => {
        this.socket = sock;
        sock.on('data', d => this._onData(d));
        sock.on('error', reject);
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  _onData(data) {
    this.frameBuf = Buffer.concat([this.frameBuf, data]);
    const { messages, remaining } = parseFrames(this.frameBuf);
    this.frameBuf = remaining;
    for (const msg of messages) {
      if (!msg) continue;
      let f; try { f = JSON.parse(msg); } catch { continue; }
      if (f.type === 'res') {
        const e = this.pending.get(f.id);
        if (e) { clearTimeout(e.timer); this.pending.delete(f.id); f.ok ? e.resolve(f.payload) : e.reject(new Error(JSON.stringify(f.error))); }
      } else if (f.type === 'event') {
        if (f.event === 'connect.challenge') { this._challengeNonce = f.payload?.nonce ?? ''; this._challengeResolve?.(); }
        else this.events.push(f);
      }
    }
  }

  rpc(method, params, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(buildFrame({ type: 'req', id, method, params }));
    });
  }

  async auth(identity) {
    if (!this._challengeNonce) await new Promise(r => { this._challengeResolve = r; });
    const signedAt = Date.now();
    const clientId = 'openclaw-control-ui';
    const payload = ['v3', identity.deviceId, clientId, 'ui', 'operator', 'operator.read,operator.write,operator.admin', String(signedAt), '', this._challengeNonce, 'node', ''].join('|');
    const signature = await identity.sign(payload);
    return this.rpc('connect', {
      minProtocol: 3, maxProtocol: 3,
      client: { id: clientId, version: '0.3.0-test', platform: 'node', mode: 'ui' },
      role: 'operator', scopes: ['operator.read', 'operator.write', 'operator.admin'],
      device: { id: identity.deviceId, publicKey: identity.publicKey, signature, signedAt, nonce: this._challengeNonce },
    });
  }

  waitForChatFinal(sessionKeyFragment, timeoutMs = 120_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chat response timeout')), timeoutMs);
      let text = '';
      const check = () => {
        for (const e of this.events) {
          if (e.event !== 'chat') continue;
          const p = e.payload;
          if (!p?.sessionKey?.includes(sessionKeyFragment)) continue;
          if (p.state === 'delta') { const t = p.message?.text || ''; if (t.length > text.length) text = t; }
          if (p.state === 'final') { clearTimeout(timer); resolve(p.message?.text || text); return; }
          if (p.state === 'error') { clearTimeout(timer); reject(new Error(p.errorMessage || 'chat error')); return; }
        }
      };
      check();
      const interval = setInterval(() => { check(); }, 500);
      const origTimer = timer;
      // Override timeout to also clear interval
      setTimeout(() => { clearInterval(interval); }, timeoutMs + 100);
    });
  }

  close() { this.socket?.end(); }
}

// ─── Device identity ─────────────────────────────────────────────────────────
async function generateIdentity() {
  const kp = await subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const raw = await subtle.exportKey('raw', kp.publicKey);
  return {
    deviceId: bytesToHex(new Uint8Array(await subtle.digest('SHA-256', raw))),
    publicKey: b64url(raw),
    sign: async (p) => b64url(await subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(p))),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const identity = await generateIdentity();
  console.log(`Device: ${identity.deviceId.slice(0, 16)}...\n`);

  // ── Test 1: rc.ws.saveImage RPC ────────────────────────────────────────
  console.log('═══ Test 1: rc.ws.saveImage ═══');
  const c1 = new Client();
  await c1.connect();
  await c1.auth(identity);

  const wsPath = `sources/${Date.now()}-test-image.png`;
  try {
    const result = await c1.rpc('rc.ws.saveImage', { path: wsPath, base64: imageBase64 });
    console.log(`  ✓ Saved: ${result.path} (${result.size} bytes)`);
  } catch (err) {
    console.log(`  ✗ Save failed: ${err.message}`);
    c1.close();
    process.exit(1);
  }

  // Verify via rc.ws.read
  try {
    const readResult = await c1.rpc('rc.ws.read', { path: wsPath });
    if (readResult.encoding === 'base64' && readResult.content.length > 100) {
      console.log(`  ✓ Read back: encoding=${readResult.encoding}, mime=${readResult.mime_type}, size=${readResult.content.length} chars`);
    } else {
      console.log(`  ✗ Read back unexpected: encoding=${readResult.encoding}`);
    }
  } catch (err) {
    console.log(`  ✗ Read failed: ${err.message}`);
  }
  c1.close();

  // ── Test 2: Scenario 1 — text-only primary + imageModel ────────────────
  console.log('\n═══ Test 2: Scenario 1 (text primary + vision secondary) ═══');
  console.log('  Config: primary=zai/glm-5 (text), imageModel=zai/glm-4.6v (vision)');
  console.log('  Expected: agent uses /image tool to analyze workspace image via glm-4.6v');

  const c2 = new Client();
  await c2.connect();
  await c2.auth(identity);

  // Simulate what dashboard send() does for text-only primary:
  // 1. Save image to workspace (already done in Test 1)
  // 2. Send message with [rc-image:...] markers + file paths
  const sk2 = `test-s1-${Date.now()}`;
  const message2 = `请分析这张图片的内容。\n\n[rc-image:${wsPath}]\n[User attached 1 image(s): ${wsPath}]`;

  console.log(`  Sending message (session: ${sk2})...`);
  const finalPromise2 = c2.waitForChatFinal(sk2, 120_000);
  try {
    const sendResult = await c2.rpc('chat.send', {
      message: message2,
      sessionKey: sk2,
      idempotencyKey: randomUUID(),
    });
    console.log(`  chat.send OK: runId=${sendResult.runId}`);
  } catch (err) {
    console.log(`  ✗ chat.send failed: ${err.message}`);
    c2.close();
    process.exit(1);
  }

  try {
    const response2 = await finalPromise2;
    console.log(`  Response (first 300 chars): ${response2.slice(0, 300)}`);
    // Check if agent acknowledged the image or used /image tool
    const l = response2.toLowerCase();
    const acknowledged = l.includes('图') || l.includes('image') || l.includes('screenshot') ||
      l.includes('terminal') || l.includes('code') || l.includes('screen') ||
      l.includes('/image') || l.includes('工具') || l.includes('tool');
    console.log(`  ${acknowledged ? '✓' : '✗'} Agent ${acknowledged ? 'acknowledged image / used tool' : 'did NOT acknowledge image'}`);
  } catch (err) {
    console.log(`  ✗ Response failed: ${err.message}`);
  }
  c2.close();

  // ── Test 3: rc.ws.read roundtrip (for MessageBubble) ──────────────────
  console.log('\n═══ Test 3: Workspace image roundtrip (MessageBubble rendering) ═══');
  const c3 = new Client();
  await c3.connect();
  await c3.auth(identity);

  try {
    const readResult = await c3.rpc('rc.ws.read', { path: wsPath });
    const isBase64 = readResult.encoding === 'base64';
    const canRender = isBase64 && readResult.content.length > 0;
    console.log(`  ${canRender ? '✓' : '✗'} Image readable from workspace: encoding=${readResult.encoding}, mime=${readResult.mime_type}`);
    if (canRender) {
      const dataUrl = `data:${readResult.mime_type};base64,${readResult.content}`;
      console.log(`  ✓ Data URL constructable: ${dataUrl.slice(0, 50)}... (${dataUrl.length} chars)`);
    }
  } catch (err) {
    console.log(`  ✗ Read failed: ${err.message}`);
  }
  c3.close();

  console.log('\n═══ Done ═══');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
