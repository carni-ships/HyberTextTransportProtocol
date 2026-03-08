import * as zlib from 'zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'util';
import { rsDecodeBuffers } from './rs';

// ---------------------------------------------------------------------------
// HYTE constants
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
const HEADER_SIZE = 9;
export const Compression = { NONE: 0, GZIP: 1, BROTLI: 2 } as const;
export const ContentType  = { HTML: 0, TAR: 1, MANIFEST: 2, FUNCTION: 3, BLOB: 4, INDEX: 5, ENCRYPTED: 8 } as const;

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

/**
 * Fetch a single tx's calldata. Accepts a single URL or a list of fallback URLs
 * tried in order on failure.
 */
export async function fetchTxInput(txHash: `0x${string}`, rpcUrl: string | string[]): Promise<Buffer> {
  const urls = Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl];
  let lastError: Error = new Error('No RPC URLs provided');

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1 }),
      });
      if (!res.ok) { lastError = new Error(`RPC request failed: HTTP ${res.status}`); continue; }
      const json = await res.json() as { result?: { input: string } | null; error?: { message: string } };
      if (json.error) { lastError = new Error(`RPC error: ${json.error.message}`); continue; }
      if (!json.result) { lastError = new Error(`Transaction not found: ${txHash}`); continue; }
      const hex = json.result.input.startsWith('0x') ? json.result.input.slice(2) : json.result.input;
      return Buffer.from(hex, 'hex');
    } catch (e) {
      lastError = e as Error;
    }
  }
  throw lastError;
}

/**
 * Batch-fetch multiple tx calldata values in a single JSON-RPC batch request.
 * Falls back to individual fetches if the batch endpoint returns an error.
 * Uses the first RPC URL in the list (primary), falling back to others on failure.
 */
export async function batchFetchTxInputs(
  hashes: `0x${string}`[],
  rpcUrl: string | string[],
): Promise<Map<`0x${string}`, Buffer>> {
  if (hashes.length === 0) return new Map();
  const urls = Array.isArray(rpcUrl) ? rpcUrl : [rpcUrl];
  const out  = new Map<`0x${string}`, Buffer>();

  // Send in batches of 20 to bound response size (~20 × 200KB = ~4MB max)
  const BATCH_SIZE = 20;
  for (let start = 0; start < hashes.length; start += BATCH_SIZE) {
    const batch = hashes.slice(start, start + BATCH_SIZE);
    const req   = batch.map((hash, j) => ({
      jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [hash], id: j,
    }));

    let succeeded = false;
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (!res.ok) continue;
        const items = await res.json() as Array<{
          id: number;
          result?: { input: string } | null;
          error?: { message: string };
        }>;
        for (const item of items) {
          if (!item.result) continue;
          const hash = batch[item.id];
          const hex  = item.result.input.startsWith('0x') ? item.result.input.slice(2) : item.result.input;
          out.set(hash, Buffer.from(hex, 'hex'));
        }
        succeeded = true;
        break;
      } catch { /* try next URL */ }
    }

    // If batch failed entirely, fall back to individual fetches
    if (!succeeded) {
      await Promise.all(batch.map(async hash => {
        try { out.set(hash, await fetchTxInput(hash, urls)); } catch { /* missing */ }
      }));
    }
  }

  return out;
}

function decodeHeader(raw: Buffer) {
  if (raw.length < HEADER_SIZE) throw new Error('Buffer too short for HYTE header');
  if (!raw.subarray(0, 4).equals(MAGIC))
    throw new Error(`Invalid HYTE magic: 0x${raw.subarray(0, 4).toString('hex')}`);
  return { version: raw[4], compression: raw[5], contentType: raw[6] };
}

export async function decompress(buf: Buffer, compression: number): Promise<Buffer> {
  if (compression === Compression.BROTLI) return Buffer.from(await brotliDecompress(buf));
  if (compression === Compression.GZIP)   return Buffer.from(await gunzip(buf));
  return buf;
}

export interface V4FileEntry {
  tx:          string;
  size:        number;
  sha256:      string;
  compression: number;
  mime:        string;
}

export interface ManifestV4 {
  v:     4;
  files: Record<string, V4FileEntry>;
}

export interface ResolveSiteResult {
  contentType: number;
  compression: number;
  payload: Buffer;
  functions?: Record<string, string>;
  fnHashes?:  Record<string, string>;
  /** Optional pre-deployed Worker URLs for functions — proxied via fetch instead of eval. */
  fnUrls?: Record<string, string>;
  /** vault field from manifest — present for ENCRYPTED manifests */
  vault?: string;
  /** present when the manifest is v4 (per-file addressing) */
  v4manifest?: ManifestV4;
}

// ---------------------------------------------------------------------------
// Manifest interface
// ---------------------------------------------------------------------------

interface ManifestV3 {
  v: number;
  compression: number;
  content_type: number;
  k?: number;
  chunks: string[];
  hashes?: string[];       // sha256 hex of each raw chunk calldata
  parity?: string[];       // parity chunk txHashes (RS)
  total_size: number;
  functions?: Record<string, string>;
  fn_hashes?: Record<string, string>;
  fn_urls?: Record<string, string>;  // pre-deployed Worker URLs for proxy execution
  vault?: string;          // HyberKeyVault address (only for ENCRYPTED content_type)
}

// ---------------------------------------------------------------------------
// Site resolution with hash verification + RS recovery
// ---------------------------------------------------------------------------

export async function resolveSite(txHash: `0x${string}`, rpcUrl: string | string[]): Promise<ResolveSiteResult> {
  const raw    = await fetchTxInput(txHash, rpcUrl);
  const header = decodeHeader(raw);
  const body   = raw.subarray(HEADER_SIZE);

  if (header.contentType === ContentType.MANIFEST) {
    const manifestRaw = JSON.parse(body.toString('utf8'));

    // v4 manifest — per-file addressing, no chunk assembly needed
    if (manifestRaw.v === 4) {
      return {
        contentType: ContentType.MANIFEST,
        compression: Compression.NONE,
        payload:     Buffer.alloc(0),
        v4manifest:  manifestRaw as ManifestV4,
      };
    }

    const manifest: ManifestV3 = manifestRaw;
    const k = manifest.k ?? manifest.chunks.length;

    // ── Batch-fetch all data chunks in one HTTP request ────────────────────
    const chunkMap  = await batchFetchTxInputs(manifest.chunks as `0x${string}`[], rpcUrl);
    const chunkBufs: Array<Buffer | null> = manifest.chunks.map((chunkHash, i) => {
      const buf = chunkMap.get(chunkHash as `0x${string}`) ?? null;
      if (buf && manifest.hashes?.[i] && sha256hex(buf) !== manifest.hashes[i]) {
        console.warn(`[resolver] chunk ${i} hash mismatch — marking missing`);
        return null;
      }
      return buf;
    });

    // ── Count good data chunks ────────────────────────────────────────────
    const goodCount = chunkBufs.filter(b => b !== null).length;

    // ── RS recovery if needed ─────────────────────────────────────────────
    let finalChunks: Array<Buffer | null> = chunkBufs;

    if (goodCount < k && manifest.parity && manifest.parity.length > 0) {
      // Batch-fetch all parity chunks
      const parityMap  = await batchFetchTxInputs(manifest.parity as `0x${string}`[], rpcUrl);
      const parityBufs = manifest.parity.map(h => parityMap.get(h as `0x${string}`) ?? null);
      const allChunks: Array<Buffer | null> = [...chunkBufs, ...parityBufs];

      if (allChunks.filter(b => b !== null).length >= k) {
        try {
          finalChunks = rsDecodeBuffers(allChunks, k);
        } catch (err: any) {
          throw new Error(`RS recovery failed: ${err.message}`);
        }
      } else {
        throw new Error(`Insufficient chunks: need ${k}, got ${allChunks.filter(b => b !== null).length}`);
      }
    } else if (goodCount < k) {
      throw new Error(`Insufficient chunks: need ${k}, got ${goodCount} (no parity available)`);
    }

    // ── Assemble (skip decompress for ENCRYPTED — Worker decrypts first) ────
    // Trim assembled buffer to total_size to remove RS padding from last chunk
    const assembled = Buffer.concat(finalChunks.slice(0, k) as Buffer[]).subarray(0, manifest.total_size);
    const isEncrypted = manifest.content_type === ContentType.ENCRYPTED;
    const payload = isEncrypted ? assembled : await decompress(assembled, manifest.compression);

    const result: ResolveSiteResult = {
      contentType: manifest.content_type as number,
      compression: manifest.compression,
      payload,
    };
    if (manifest.v >= 2 && manifest.functions && typeof manifest.functions === 'object') {
      result.functions = manifest.functions as Record<string, string>;
    }
    if (manifest.fn_hashes) result.fnHashes = manifest.fn_hashes as Record<string, string>;
    if (manifest.fn_urls)   result.fnUrls   = manifest.fn_urls  as Record<string, string>;
    if (manifest.vault)     result.vault     = manifest.vault;
    return result;
  }

  // For non-manifest ENCRYPTED tx, skip decompression — Worker decrypts first
  const isEncrypted = header.contentType === ContentType.ENCRYPTED;
  const payload = isEncrypted ? body : await decompress(body, header.compression);
  return { contentType: header.contentType as number, compression: header.compression, payload };
}

/**
 * Fetch a FUNCTION-type HYTE tx and return the decompressed JS source as a string.
 * Also handles MANIFEST-type txs produced when a large function bundle was chunked:
 *   the manifest's content_type field must equal FUNCTION (3).
 * Optionally verify the single-tx payload against a known sha256 hash.
 */
export async function resolveFunctionCode(
  txHash: `0x${string}`,
  rpcUrl: string | string[],
  expectedHash?: string,
): Promise<string> {
  const raw    = await fetchTxInput(txHash, rpcUrl);
  const header = decodeHeader(raw);

  // Chunked function bundle — manifest points to the actual FUNCTION chunks
  if (header.contentType === ContentType.MANIFEST) {
    const result = await resolveSite(txHash, rpcUrl);
    if (result.contentType !== ContentType.FUNCTION) {
      throw new Error(`MANIFEST content_type is ${result.contentType}, expected FUNCTION (3)`);
    }
    return result.payload.toString('utf8');
  }

  if (header.contentType !== ContentType.FUNCTION) {
    throw new Error(`Expected FUNCTION content type (3), got ${header.contentType}`);
  }
  if (expectedHash) {
    const actual = sha256hex(raw);
    if (actual !== expectedHash) throw new Error(`Function payload hash mismatch for ${txHash}`);
  }
  const body = raw.subarray(HEADER_SIZE);
  const decompressed = await decompress(body, header.compression);
  return decompressed.toString('utf8');
}

/** Pure buffer-based tar extractor — no Node.js streams required. */
export function extractTar(buf: Buffer): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every(b => b === 0)) break;

    const nameRaw  = header.subarray(0, 100).toString('ascii').replace(/\0+$/, '');
    const prefix   = header.subarray(345, 500).toString('ascii').replace(/\0+$/, '');
    const fullName = prefix ? `${prefix}/${nameRaw}` : nameRaw;

    let size = 0;
    if (header[124] & 0x80) {
      for (let i = 125; i < 136; i++) size = size * 256 + header[i];
    } else {
      const sizeStr = header.subarray(124, 136).toString('ascii').trim().replace(/\0+$/, '');
      size = sizeStr ? parseInt(sizeStr, 8) : 0;
    }
    if (!Number.isFinite(size) || size < 0) size = 0;

    const typeFlag = header[156];
    offset += BLOCK;

    const isRegularFile = typeFlag === 0 || typeFlag === 0x30;
    if (isRegularFile && size > 0 && fullName) {
      const path = fullName.replace(/^\.\//, '').replace(/^\//, '');
      if (path) files.set(path, buf.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return Promise.resolve(files);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
