/**
 * Ed25519 device identity for OpenClaw gateway handshake.
 *
 * Implements the device-auth protocol (v3 signature payload) required by
 * all gateway WS clients.  Keys are generated via Web Crypto and persisted
 * in localStorage so the device ID remains stable across page reloads.
 */

const STORAGE_KEY = 'rc:device-identity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StoredIdentity {
  version: 1;
  deviceId: string;          // SHA-256 hex of raw public key (64 chars)
  publicKeyB64u: string;     // base64url of raw 32-byte Ed25519 key
  privateKeyJwk: JsonWebKey;
  publicKeyJwk: JsonWebKey;
  createdAtMs: number;
}

export interface DeviceIdentity {
  deviceId: string;
  publicKey: string; // base64url raw Ed25519
  sign(payload: string): Promise<string>; // returns base64url signature
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

async function generateIdentity(): Promise<{
  identity: DeviceIdentity;
  stored: StoredIdentity;
}> {
  const keyPair = await crypto.subtle.generateKey('Ed25519', true, [
    'sign',
    'verify',
  ]);

  // Raw 32-byte Ed25519 public key
  const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const publicKeyB64u = base64UrlEncode(rawPub);

  // Device ID = SHA-256(raw public key) → hex
  const hashBuf = await crypto.subtle.digest('SHA-256', rawPub);
  const deviceId = bytesToHex(new Uint8Array(hashBuf));

  // Export both keys as JWK for persistent storage
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

  const stored: StoredIdentity = {
    version: 1,
    deviceId,
    publicKeyB64u,
    privateKeyJwk,
    publicKeyJwk,
    createdAtMs: Date.now(),
  };

  const sign = async (payload: string): Promise<string> => {
    const sig = await crypto.subtle.sign(
      'Ed25519',
      keyPair.privateKey,
      new TextEncoder().encode(payload),
    );
    return base64UrlEncode(sig);
  };

  return { identity: { deviceId, publicKey: publicKeyB64u, sign }, stored };
}

// ---------------------------------------------------------------------------
// Restore from storage
// ---------------------------------------------------------------------------

async function restoreIdentity(stored: StoredIdentity): Promise<DeviceIdentity> {
  // Import only the private key (non-extractable – stays inside CryptoKey)
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    stored.privateKeyJwk,
    'Ed25519',
    false,
    ['sign'],
  );

  return {
    deviceId: stored.deviceId,
    publicKey: stored.publicKeyB64u,
    sign: async (payload: string): Promise<string> => {
      const sig = await crypto.subtle.sign(
        'Ed25519',
        privateKey,
        new TextEncoder().encode(payload),
      );
      return base64UrlEncode(sig);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cached: DeviceIdentity | null = null;

/**
 * Returns a stable device identity, creating one on first call.
 * The Ed25519 key pair is persisted in localStorage so the device ID
 * survives page reloads and browser restarts.
 */
export async function getDeviceIdentity(): Promise<DeviceIdentity | null> {
  if (cached) return cached;

  // Web Crypto API is only available in secure contexts (HTTPS, localhost, 127.0.0.1).
  // When accessing the Dashboard via a LAN IP over HTTP, crypto.subtle is undefined.
  // In this case, return null so the client can fall back to token-only auth.
  if (!globalThis.crypto?.subtle) {
    return null;
  }

  // Try to restore an existing identity
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const stored: StoredIdentity = JSON.parse(raw);
      if (stored.version === 1 && stored.deviceId && stored.privateKeyJwk) {
        cached = await restoreIdentity(stored);
        return cached;
      }
    }
  } catch {
    // Corrupted or incompatible – fall through to regenerate
  }

  // Generate a fresh identity
  const { identity, stored } = await generateIdentity();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // localStorage may be full; identity still works for this session
  }

  cached = identity;
  return identity;
}

/**
 * Build the v3 signature payload string.
 *
 * Format: `v3|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce|platform|deviceFamily`
 */
export function buildV3Payload(opts: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAt: number;
  token: string;
  nonce: string;
  platform: string;
  deviceFamily: string;
}): string {
  return [
    'v3',
    opts.deviceId,
    opts.clientId,
    opts.clientMode,
    opts.role,
    opts.scopes.join(','),
    opts.signedAt.toString(),
    opts.token,
    opts.nonce,
    opts.platform,
    opts.deviceFamily,
  ].join('|');
}
