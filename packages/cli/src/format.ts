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
} as const;
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
