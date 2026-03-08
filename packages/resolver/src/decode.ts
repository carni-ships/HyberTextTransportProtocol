import * as zlib from 'zlib';
import * as crypto from 'node:crypto';
import { promisify } from 'util';
import { decodeHeader, ContentType, Compression, HEADER_SIZE } from './format';
import { fetchTxInput } from './fetch';
import { rsDecodeBuffers } from './rs';

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip           = promisify(zlib.gunzip);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ManifestJson {
  v: number;
  compression: number;
  content_type: number;
  k?: number;
  chunks: string[];
  hashes?: string[];       // sha256 hex of raw chunk calldata (v3)
  parity?: string[];       // RS parity chunk txHashes (v3)
  total_size: number;
  functions?: Record<string, string>;
  fn_hashes?: Record<string, string>;
}

export interface DecodedSite {
  contentType: number;
  payload: Buffer; // decompressed
  functions?: Record<string, string>;
  fnHashes?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

export async function resolveSite(txHash: `0x${string}`): Promise<DecodedSite> {
  const raw    = await fetchTxInput(txHash);
  const header = decodeHeader(raw);
  const body   = raw.subarray(HEADER_SIZE);

  if (header.contentType === ContentType.MANIFEST) {
    const manifest: ManifestJson = JSON.parse(body.toString('utf8'));
    const k = manifest.k ?? manifest.chunks.length;

    // ── Fetch data chunks with hash verification ──────────────────────────
    const chunkBufs: Array<Buffer | null> = [];
    for (let i = 0; i < manifest.chunks.length; i++) {
      try {
        const buf = await fetchTxInput(manifest.chunks[i] as `0x${string}`);
        if (manifest.hashes?.[i] && sha256hex(buf) !== manifest.hashes[i]) {
          console.warn(`[resolver] chunk ${i} hash mismatch — marking missing`);
          chunkBufs.push(null);
          continue;
        }
        chunkBufs.push(buf);
      } catch {
        chunkBufs.push(null);
      }
    }

    const goodCount = chunkBufs.filter(b => b !== null).length;
    let finalChunks: Array<Buffer | null> = chunkBufs;

    // ── RS recovery ───────────────────────────────────────────────────────
    if (goodCount < k && manifest.parity && manifest.parity.length > 0) {
      const allChunks: Array<Buffer | null> = [...chunkBufs];
      for (const parityHash of manifest.parity) {
        if (allChunks.filter(b => b !== null).length >= k) break;
        try {
          allChunks.push(await fetchTxInput(parityHash as `0x${string}`));
        } catch {
          allChunks.push(null);
        }
      }
      if (allChunks.filter(b => b !== null).length >= k) {
        finalChunks = rsDecodeBuffers(allChunks, k);
      } else {
        throw new Error(`Insufficient chunks for recovery: need ${k}`);
      }
    } else if (goodCount < k) {
      throw new Error(`Insufficient chunks: need ${k}, got ${goodCount}`);
    }

    // Trim assembled buffer to total_size (removes RS zero-padding from last chunk)
    const assembled   = Buffer.concat(finalChunks.slice(0, k) as Buffer[]).subarray(0, manifest.total_size);
    const decompressed = await decompress(assembled, manifest.compression);

    const result: DecodedSite = { contentType: manifest.content_type, payload: decompressed };
    if (manifest.v >= 2 && manifest.functions) result.functions = manifest.functions;
    if (manifest.fn_hashes) result.fnHashes = manifest.fn_hashes;
    return result;
  }

  const decompressed = await decompress(body, header.compression);
  return { contentType: header.contentType, payload: decompressed };
}

export async function resolveFunctionCode(
  txHash: `0x${string}`,
  expectedHash?: string,
): Promise<string> {
  const raw    = await fetchTxInput(txHash);
  const header = decodeHeader(raw);
  const body   = raw.subarray(HEADER_SIZE);
  if (expectedHash && sha256hex(raw) !== expectedHash) {
    throw new Error(`Function payload hash mismatch for ${txHash}`);
  }
  const decompressed = await decompress(body, header.compression);
  return decompressed.toString('utf8');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function decompress(buf: Buffer, compression: number): Promise<Buffer> {
  switch (compression) {
    case Compression.BROTLI: return Buffer.from(await brotliDecompress(buf));
    case Compression.GZIP:   return Buffer.from(await gunzip(buf));
    default:                 return buf;
  }
}

function sha256hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
