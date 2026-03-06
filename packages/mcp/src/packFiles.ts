import * as zlib from 'zlib';
import { promisify } from 'util';
import { pack as tarPack } from 'tar-stream';

const brotliCompress = promisify(zlib.brotliCompress);
const gzip           = promisify(zlib.gzip);

const MAGIC       = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
const HEADER_SIZE = 9;

const Compression = { NONE: 0, GZIP: 1, BROTLI: 2 } as const;
const ContentType  = { HTML: 0, TAR: 1, MANIFEST: 2 } as const;

export const CHUNK_SIZE = 400 * 1024; // 400 KB per chunk tx

function encodeHeader(compression: number, contentType: number): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(h, 0);
  h[4] = 0x01;
  h[5] = compression;
  h[6] = contentType;
  return h;
}

function createTarBuffer(files: Map<string, Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const packer = tarPack();
    const chunks: Buffer[] = [];
    packer.on('data', (c: Buffer) => chunks.push(c));
    packer.on('end', () => resolve(Buffer.concat(chunks)));
    packer.on('error', reject);

    const entries = [...files.entries()];
    const next = (i: number) => {
      if (i >= entries.length) { packer.finalize(); return; }
      const [name, buf] = entries[i];
      packer.entry({ name }, buf, (err) => { if (err) reject(err); else next(i + 1); });
    };
    next(0);
  });
}

export interface PackResult {
  // compressed payload without HYTE header (ready to be chunked or wrapped)
  compressed: Buffer;
  contentType: number;
  compression: number;
  fileCount: number;
}

export async function packFiles(files: Map<string, Buffer>): Promise<PackResult> {
  const keys    = [...files.keys()];
  const htmlOnly = files.size === 1 && keys[0].match(/\.html?$/i);

  const raw         = htmlOnly ? files.get(keys[0])! : await createTarBuffer(files);
  const contentType = htmlOnly ? ContentType.HTML : ContentType.TAR;

  // Use gzip (level 1 = fastest) — much lower CPU than brotli, safe for Worker limits.
  // The resolver handles both; brotli is reserved for the CLI where CPU time is unlimited.
  const compressed = Buffer.from(await gzip(raw, { level: 1 }));

  return { compressed, contentType, compression: Compression.GZIP, fileCount: files.size };
}

/** Wrap compressed payload as a single HYTE transaction payload. */
export function wrapSingle(pack: PackResult): Buffer {
  return Buffer.concat([encodeHeader(pack.compression, pack.contentType), pack.compressed]);
}

/** Split compressed payload into chunk buffers + a manifest payload. */
export function buildChunks(pack: PackResult): { chunks: Buffer[]; manifestPayload: Buffer } {
  const chunks: Buffer[] = [];
  for (let i = 0; i < pack.compressed.length; i += CHUNK_SIZE) {
    chunks.push(pack.compressed.subarray(i, i + CHUNK_SIZE));
  }

  // Placeholder manifest — chunk tx hashes filled in after broadcasting
  return { chunks, manifestPayload: Buffer.alloc(0) };
}

export function buildManifestPayload(chunkHashes: string[], pack: PackResult): Buffer {
  const manifest = JSON.stringify({
    v: 1,
    compression: pack.compression,
    content_type: pack.contentType,
    chunks: chunkHashes,
    total_size: pack.compressed.length,
  });
  return Buffer.concat([
    encodeHeader(Compression.NONE, ContentType.MANIFEST),
    Buffer.from(manifest, 'utf8'),
  ]);
}
