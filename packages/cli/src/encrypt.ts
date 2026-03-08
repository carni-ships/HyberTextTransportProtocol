/**
 * encrypt.ts — site encryption and key-wrapping utilities for HyberText.
 *
 * Uses Node.js built-in crypto (no extra deps for AES-GCM + HKDF).
 * Uses @noble/curves/x25519 for X25519 ECDH (pure JS, works in Workers too).
 *
 * Encrypted HYTE payload layout (after the 9-byte HYTE header):
 *   [0..11]  IV (AES-256-GCM nonce, 12 bytes, random per publish)
 *   [12..]   AES-256-GCM ciphertext with auth tag appended (Node.js cipher.getAuthTag())
 *             = [ciphertext][16-byte authTag]
 *
 * Wrapped key blob stored in HyberKeyVault (92 bytes total):
 *   [0..31]   Publisher's ephemeral X25519 public key
 *   [32..43]  AES-256-GCM wrapping IV (12 bytes, random per publish)
 *   [44..75]  AES-256-GCM encrypted CEK (32 bytes)
 *   [76..91]  AES-256-GCM auth tag (16 bytes)
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';

// ---------------------------------------------------------------------------
// Site payload encryption
// ---------------------------------------------------------------------------

/** Generate a random 32-byte AES-256-GCM Content Encryption Key. */
export function generateCEK(): Buffer {
  return randomBytes(32);
}

/**
 * Encrypt `plaintext` (the compressed inner HYTE payload) with AES-256-GCM.
 * Returns: IV (12) + ciphertext + auth tag (16).
 */
export function encryptPayload(plaintext: Buffer, cek: Buffer): Buffer {
  const iv     = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cek, iv);
  const ct     = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]);
}

/**
 * Decrypt an encrypted payload (output of encryptPayload) with AES-256-GCM.
 * Input: IV (12) + ciphertext + auth tag (16).
 */
export function decryptPayload(encryptedPayload: Buffer, cek: Buffer): Buffer {
  const iv         = encryptedPayload.subarray(0, 12);
  const tag        = encryptedPayload.subarray(encryptedPayload.length - 16);
  const ciphertext = encryptedPayload.subarray(12, encryptedPayload.length - 16);
  const decipher   = createDecipheriv('aes-256-gcm', cek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Key wrapping (X25519 ECDH + HKDF-SHA256 + AES-256-GCM)
// ---------------------------------------------------------------------------

/**
 * Wrap a CEK for a Worker identified by its static X25519 public key.
 *
 * Returns a 92-byte blob:
 *   ephPub(32) + wrapIV(12) + wrappedCEK(32) + tag(16)
 *
 * @param cek           32-byte AES-256-GCM key to wrap
 * @param vaultPubKey   32-byte raw X25519 public key of the Worker vault
 */
export function wrapCEK(cek: Buffer, vaultPubKey: Buffer): Buffer {
  if (vaultPubKey.length !== 32) throw new Error('vaultPubKey must be 32 bytes');
  if (cek.length !== 32)         throw new Error('CEK must be 32 bytes');

  // Ephemeral X25519 keypair
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub  = x25519.getPublicKey(ephPriv);

  // ECDH → shared secret
  const sharedSecret = x25519.getSharedSecret(ephPriv, new Uint8Array(vaultPubKey));

  // HKDF-SHA256 → 32-byte key wrapping key
  const kwk = hkdfSync('sha256', sharedSecret, Buffer.alloc(32), 'hybertext-kek-v1', 32);

  // AES-256-GCM wrap the CEK
  const wrapIV = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(kwk), wrapIV);
  const wCEK   = Buffer.concat([cipher.update(cek), cipher.final()]);
  const tag    = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from(ephPub),  // 32 bytes
    wrapIV,               // 12 bytes
    wCEK,                 // 32 bytes
    tag,                  // 16 bytes
  ]); // total: 92 bytes
}

/**
 * Unwrap a CEK using the Worker's static X25519 private key.
 * Input: 92-byte blob from wrapCEK.
 */
export function unwrapCEK(wrappedKey: Buffer, vaultPrivKey: Buffer): Buffer {
  if (wrappedKey.length !== 92) throw new Error(`wrappedKey must be 92 bytes, got ${wrappedKey.length}`);
  if (vaultPrivKey.length !== 32) throw new Error('vaultPrivKey must be 32 bytes');

  const ephPub  = wrappedKey.subarray(0, 32);
  const wrapIV  = wrappedKey.subarray(32, 44);
  const wCEK    = wrappedKey.subarray(44, 76);
  const tag     = wrappedKey.subarray(76, 92);

  // ECDH
  const sharedSecret = x25519.getSharedSecret(new Uint8Array(vaultPrivKey), new Uint8Array(ephPub));

  // HKDF
  const kwk = hkdfSync('sha256', sharedSecret, Buffer.alloc(32), 'hybertext-kek-v1', 32);

  // AES-256-GCM decrypt
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(kwk), wrapIV);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(wCEK), decipher.final()]);
}

// ---------------------------------------------------------------------------
// X25519 key generation
// ---------------------------------------------------------------------------

/** Generate a new X25519 keypair. Returns { privateKey, publicKey } as 32-byte hex strings. */
export function generateVaultKeypair(): { privateKey: string; publicKey: string } {
  const privBytes = x25519.utils.randomPrivateKey();
  const pubBytes  = x25519.getPublicKey(privBytes);
  return {
    privateKey: Buffer.from(privBytes).toString('hex'),
    publicKey:  Buffer.from(pubBytes).toString('hex'),
  };
}

/** Derive the X25519 public key from a hex private key. */
export function derivePublicKey(privateKeyHex: string): string {
  const privBytes = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex');
  return Buffer.from(x25519.getPublicKey(new Uint8Array(privBytes))).toString('hex');
}
