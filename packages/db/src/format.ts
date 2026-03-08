import { gzipSync, gunzipSync, strToU8, strFromU8 } from 'fflate';
import type { DbPatch, DbSnapshot } from './types';

// ---------------------------------------------------------------------------
// HYTE constants — must stay in sync with packages/mcp/src/packFiles.ts
// ---------------------------------------------------------------------------

export const MAGIC       = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
export const HEADER_SIZE = 9;
export const VERSION     = 0x01;

export const Compression = { NONE: 0, GZIP: 1 } as const;
export const ContentType = {
  HTML: 0, TAR: 1, MANIFEST: 2, FUNCTION: 3, BLOB: 4,
  DB_PATCH: 5, DB_SNAPSHOT: 6,
} as const;

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function encodeHeader(compression: number, contentType: number): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(h, 0);
  h[4] = VERSION;
  h[5] = compression;
  h[6] = contentType;
  return h;
}

function decodeHeader(buf: Buffer): { version: number; compression: number; contentType: number } {
  if (buf.length < HEADER_SIZE) throw new Error('Buffer too short for HYTE header');
  if (!buf.subarray(0, 4).equals(MAGIC)) {
    throw new Error(`Invalid HYTE magic: 0x${buf.subarray(0, 4).toString('hex')}`);
  }
  return { version: buf[4], compression: buf[5], contentType: buf[6] };
}

function decompress(data: Buffer, compression: number): Buffer {
  if (compression === Compression.GZIP) return Buffer.from(gunzipSync(new Uint8Array(data)));
  return data;
}

// ---------------------------------------------------------------------------
// Encoding: patch and snapshot → HYTE wire format
// ---------------------------------------------------------------------------

export function encodePatch(patch: DbPatch): Buffer {
  const json       = strToU8(JSON.stringify(patch));
  const compressed = gzipSync(json, { level: 1 }); // fast gzip for small writes
  return Buffer.concat([
    encodeHeader(Compression.GZIP, ContentType.DB_PATCH),
    Buffer.from(compressed),
  ]);
}

export function encodeSnapshot(snapshot: DbSnapshot): Buffer {
  const json       = strToU8(JSON.stringify(snapshot));
  const compressed = gzipSync(json, { level: 6 }); // better compression for larger payloads
  return Buffer.concat([
    encodeHeader(Compression.GZIP, ContentType.DB_SNAPSHOT),
    Buffer.from(compressed),
  ]);
}

// ---------------------------------------------------------------------------
// Decoding: HYTE wire format → patch or snapshot
// ---------------------------------------------------------------------------

export type DecodedDbPayload =
  | { type: 'patch';    patch:    DbPatch    }
  | { type: 'snapshot'; snapshot: DbSnapshot };

export function decodeDbPayload(buf: Buffer): DecodedDbPayload {
  const header = decodeHeader(buf);
  const body   = decompress(buf.subarray(HEADER_SIZE), header.compression);
  const json   = JSON.parse(strFromU8(new Uint8Array(body)));

  if (header.contentType === ContentType.DB_PATCH)    return { type: 'patch',    patch:    json as DbPatch    };
  if (header.contentType === ContentType.DB_SNAPSHOT) return { type: 'snapshot', snapshot: json as DbSnapshot };

  throw new Error(`Not a DB payload: contentType=${header.contentType}`);
}

export { decodeHeader };
