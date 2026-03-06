export const MAGIC = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
export const HEADER_SIZE = 9;

export const Compression = {
  NONE: 0,
  GZIP: 1,
  BROTLI: 2,
} as const;

export const ContentType = {
  HTML: 0,
  TAR: 1,
  MANIFEST: 2,
} as const;

export interface HyteHeader {
  version: number;
  compression: number;
  contentType: number;
}

export function decodeHeader(buf: Buffer): HyteHeader {
  if (buf.length < HEADER_SIZE) throw new Error('Buffer too short for HYTE header');
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`Invalid HYTE magic bytes: 0x${buf.subarray(0, 4).toString('hex')}`);
  }
  return {
    version: buf[4],
    compression: buf[5],
    contentType: buf[6],
  };
}
