/**
 * vault.ts — Worker-side vault key management and site decryption.
 *
 * The Worker holds a static X25519 private key (VAULT_X25519_PRIVKEY env secret).
 * This module unwraps CEKs from the 92-byte blobs stored in HyberKeyVault,
 * then uses them to decrypt ENCRYPTED HYTE payloads.
 *
 * Uses @noble/curves/x25519 for X25519 ECDH (pure JS, works in Workers).
 * Uses SubtleCrypto (built-in, available in Cloudflare Workers via Web Crypto).
 */

import { x25519 } from '@noble/curves/ed25519';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hkdf32(sharedSecret: Uint8Array): Promise<CryptoKey> {
  const ikmKey = await crypto.subtle.importKey(
    'raw', sharedSecret, { name: 'HKDF' }, false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name:  'HKDF',
      hash:  'SHA-256',
      salt:  new Uint8Array(32),
      info:  new TextEncoder().encode('hybertext-kek-v1'),
    },
    ikmKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Key unwrapping
// ---------------------------------------------------------------------------

/**
 * Unwrap a CEK from the 92-byte vault blob using the Worker's X25519 private key.
 *
 * Blob layout: ephPub(32) + wrapIV(12) + wrappedCEK(32) + tag(16)
 * Returns a raw 32-byte AES-256-GCM CryptoKey ready for decryption.
 */
export async function unwrapCEK(
  wrappedKey: Uint8Array,
  vaultPrivKeyHex: string,
): Promise<CryptoKey> {
  if (wrappedKey.length !== 92) throw new Error(`Invalid wrappedKey length: ${wrappedKey.length}`);

  const privBytes    = hexToBytes(vaultPrivKeyHex.replace(/^0x/, ''));
  const ephPub       = wrappedKey.subarray(0, 32);
  const wrapIV       = wrappedKey.subarray(32, 44);
  const wrappedCEK   = wrappedKey.subarray(44, 92); // 32 ciphertext + 16 tag

  // X25519 ECDH
  const sharedSecret = x25519.getSharedSecret(privBytes, ephPub);

  // HKDF-SHA256 → AES-256-GCM key wrapping key
  const kwk = await hkdf32(sharedSecret);

  // AES-256-GCM decrypt the 48-byte wrapped blob (32-byte CEK + 16-byte tag)
  const rawCEK = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapIV },
    kwk,
    wrappedCEK,
  );

  return crypto.subtle.importKey(
    'raw', rawCEK, { name: 'AES-GCM' }, false, ['decrypt'],
  );
}

// ---------------------------------------------------------------------------
// Site payload decryption
// ---------------------------------------------------------------------------

/**
 * Decrypt an ENCRYPTED HYTE payload (after the 9-byte HYTE header).
 *
 * Payload layout: IV(12) + ciphertext_with_tag(N+16)
 * Returns: the plaintext compressed inner payload (still needs decompress).
 */
export async function decryptPayload(
  encryptedPayload: Uint8Array,
  cek: CryptoKey,
): Promise<Uint8Array> {
  const iv         = encryptedPayload.subarray(0, 12);
  const ciphertext = encryptedPayload.subarray(12); // includes 16-byte auth tag at end

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    cek,
    ciphertext,
  );

  return new Uint8Array(plaintext);
}

// ---------------------------------------------------------------------------
// Vault contract read helpers
// ---------------------------------------------------------------------------

export interface VaultRecord {
  publisher:   string;
  priceWei:    bigint;
  keyDuration: number;
  createdAt:   number;
  active:      boolean;
  wrappedKey:  Uint8Array;
}

// Selector: cast sig "getVault(bytes32)" = 0x7a9e5e4b
const GET_VAULT_SELECTOR = '7a9e5e4b';

export async function fetchVaultRecord(
  siteTxHash: string,
  vaultAddress: string,
  rpcUrl: string,
): Promise<VaultRecord | null> {
  const hash32 = siteTxHash.startsWith('0x') ? siteTxHash.slice(2) : siteTxHash;
  const calldata = '0x' + GET_VAULT_SELECTOR + hash32.padStart(64, '0');

  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      jsonrpc: '2.0', method: 'eth_call',
      params: [{ to: vaultAddress, data: calldata }, 'latest'], id: 1,
    }),
  });
  if (!res.ok) throw new Error(`RPC eth_call failed: HTTP ${res.status}`);
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`eth_call error: ${json.error.message}`);
  if (!json.result || json.result === '0x') return null;

  return decodeVaultRecord(json.result);
}

function decodeVaultRecord(hex: string): VaultRecord | null {
  const data = hex.startsWith('0x') ? hex.slice(2) : hex;
  // ABI-decoded tuple layout for VaultRecord (all fixed fields + dynamic bytes):
  // The struct is returned as a tuple. Dynamic field (bytes wrappedKey) is ABI-encoded
  // with an offset pointer. Layout:
  //   [0..63]   publisher (address, padded)
  //   [64..127] priceWei (uint256)
  //   [128..191] keyDuration (uint64, padded)
  //   [192..255] createdAt (uint64, padded)
  //   [256..319] active (bool, padded)
  //   [320..383] offset to bytes wrappedKey data
  //   [384..447] bytes length (should be 92)
  //   [448..639] bytes data (padded to 96 = ceil(92/32)*32)

  if (data.length < 448) return null;

  const publisher   = '0x' + data.slice(24, 64);
  const priceWei    = BigInt('0x' + data.slice(64, 128));
  const keyDuration = parseInt(data.slice(128 + 48, 192), 16);
  const createdAt   = parseInt(data.slice(192 + 48, 256), 16);
  const active      = data.slice(319, 320) === '1';

  // wrappedKey bytes at offset 448 (length 92)
  if (publisher === '0x' + '0'.repeat(40)) return null; // not registered

  const keyHex = data.slice(448, 448 + 184); // 92 bytes = 184 hex chars
  const wrappedKey = hexToBytes(keyHex);

  return { publisher, priceWei, keyDuration, createdAt, active, wrappedKey };
}

// ---------------------------------------------------------------------------
// Public key exposure
// ---------------------------------------------------------------------------

/** Derive the X25519 public key from the Worker's private key hex. */
export function getVaultPublicKey(vaultPrivKeyHex: string): string {
  const privBytes = hexToBytes(vaultPrivKeyHex.replace(/^0x/, ''));
  const pubBytes  = x25519.getPublicKey(privBytes);
  return Buffer.from(pubBytes).toString('hex');
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const buf = new Uint8Array(h.length / 2);
  for (let i = 0; i < buf.length; i++) {
    buf[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return buf;
}
