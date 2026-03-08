export const MAGIC = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
export const VERSION = 0x01;
export const HEADER_SIZE = 9; // 4 magic + 1 version + 1 compression + 1 content_type + 2 reserved

export const Compression = {
  NONE: 0,
  GZIP: 1,
  BROTLI: 2,
} as const;
export type CompressionType = (typeof Compression)[keyof typeof Compression];

export const ContentType = {
  HTML: 0,
  TAR: 1,
  MANIFEST: 2,
  FUNCTION: 3,
  BLOB: 4,
  // 5 = DB_PATCH, 6 = DB_SNAPSHOT (defined in @hybertext/db)
  BLOB_REF: 7,   // calldata pointer to an EIP-4844 blob (blobVersionedHash + blockNumber)
  INDEX:    5,   // gzip JSON IndexEntry[] snapshot published by a gateway; addressable via HyberIndex
  ENCRYPTED: 8,  // AES-256-GCM encrypted HYTE payload; see encrypt.ts for layout
} as const;

// Encrypted payload layout (starts at offset HEADER_SIZE):
//   [0..11]  IV (AES-256-GCM nonce, 12 bytes)
//   [12..27] Auth tag (16 bytes, appended to ciphertext by SubtleCrypto)
//   [28..]   Ciphertext (the inner HYTE payload, length = total - 28)
// Note: SubtleCrypto.encrypt appends the 16-byte tag to the ciphertext,
// so the raw encrypted bytes are actually [ciphertext + tag]. We prefix IV
// separately, giving layout: IV(12) + encrypted_with_tag(N+16).
export const ENC_IV_OFFSET  = 0;
export const ENC_IV_SIZE    = 12;
export const ENC_TAG_SIZE   = 16; // embedded at end of ciphertext by SubtleCrypto
export type ContentTypeValue = (typeof ContentType)[keyof typeof ContentType];

export interface HyteHeader {
  version: number;
  compression: CompressionType;
  contentType: ContentTypeValue;
}

export function encodeHeader(h: HyteHeader): Buffer {
  const buf = Buffer.alloc(HEADER_SIZE, 0);
  MAGIC.copy(buf, 0);
  buf[4] = h.version;
  buf[5] = h.compression;
  buf[6] = h.contentType;
  // bytes 7-8 are reserved (0x0000)
  return buf;
}

export function decodeHeader(buf: Buffer): HyteHeader {
  if (buf.length < HEADER_SIZE) throw new Error('Buffer too short for HYTE header');
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('Invalid HYTE magic bytes');
  return {
    version: buf[4],
    compression: buf[5] as CompressionType,
    contentType: buf[6] as ContentTypeValue,
  };
}
