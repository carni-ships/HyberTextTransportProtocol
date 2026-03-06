import * as zlib from 'zlib';
import { promisify } from 'util';
import { decodeHeader, ContentType, Compression, HEADER_SIZE } from './format';
import { fetchTxInput } from './fetch';

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

interface ManifestJson {
  v: number;
  compression: number;
  content_type: number;
  chunks: string[];
  total_size: number;
}

export interface DecodedSite {
  contentType: number;
  payload: Buffer; // decompressed
}

export async function resolveSite(txHash: `0x${string}`): Promise<DecodedSite> {
  const raw = await fetchTxInput(txHash);
  const header = decodeHeader(raw);
  const payload = raw.subarray(HEADER_SIZE);

  if (header.contentType === ContentType.MANIFEST) {
    const manifest: ManifestJson = JSON.parse(payload.toString('utf8'));
    // Fetch all chunks in parallel — they're raw bytes with no HYTE header
    const chunkBuffers = await Promise.all(
      manifest.chunks.map((h) => fetchTxInput(h as `0x${string}`))
    );
    const assembled = Buffer.concat(chunkBuffers);
    const decompressed = await decompress(assembled, manifest.compression);
    return { contentType: manifest.content_type, payload: decompressed };
  }

  const decompressed = await decompress(payload, header.compression);
  return { contentType: header.contentType, payload: decompressed };
}

async function decompress(buf: Buffer, compression: number): Promise<Buffer> {
  switch (compression) {
    case Compression.BROTLI:
      return Buffer.from(await brotliDecompress(buf));
    case Compression.GZIP:
      return Buffer.from(await gunzip(buf));
    case Compression.NONE:
    default:
      return buf;
  }
}
