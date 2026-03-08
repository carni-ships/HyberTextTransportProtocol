import * as zlib from 'zlib';
import { promisify } from 'util';

const brotliCompress = promisify(zlib.brotliCompress);
const gzip           = promisify(zlib.gzip);

const MAGIC       = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
const HEADER_SIZE = 9;

const Compression = { NONE: 0, GZIP: 1, BROTLI: 2 } as const;
const ContentType  = { HTML: 0, TAR: 1, MANIFEST: 2, FUNCTION: 3, BLOB: 4, BLOB_REF: 7 } as const;

export const CHUNK_SIZE = 100 * 1024; // 100 KB per chunk tx (Berachain calldata limit)

function encodeHeader(compression: number, contentType: number): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(h, 0);
  h[4] = 0x01;
  h[5] = compression;
  h[6] = contentType;
  return h;
}

/** Pure buffer-based POSIX ustar tar creator — no Node.js streams required. */
function createTarBuffer(files: Map<string, Buffer>): Buffer {
  const BLOCK = 512;
  const blocks: Buffer[] = [];

  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(BLOCK);

    // Name (0-99): truncate to 99 chars + null
    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 99));

    // Mode (100-107): 0000644\0
    header.write('0000644\0', 100, 'ascii');

    // uid/gid (108-115, 116-123): 0000000\0
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');

    // Size (124-135): 11-digit octal + \0
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');

    // Mtime (136-147): current unix time, 11 octal digits + \0
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');

    // Typeflag (156): '0' = regular file
    header[156] = 0x30;

    // POSIX magic (257-262): 'ustar\0'
    header.write('ustar\0', 257, 'ascii');

    // ustar version (263-264): '00'
    header.write('00', 263, 'ascii');

    // Checksum: fill field with spaces, compute sum, write as 6 octal + \0 + space
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += header[i];
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

    blocks.push(header);

    // Content padded to 512-byte boundary
    const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
    content.copy(padded);
    if (padded.length > 0) blocks.push(padded);
  }

  // End-of-archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
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

  const raw         = htmlOnly ? files.get(keys[0])! : createTarBuffer(files);
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

export function buildManifestPayload(
  chunkHashes: string[],
  pack: PackResult,
  functions?: Record<string, string>,
  chunkHexHashes?: string[],
  fnHashes?: Record<string, string>,
): Buffer {
  const hasFunctions = functions && Object.keys(functions).length > 0;
  const hasHashes    = chunkHexHashes && chunkHexHashes.length === chunkHashes.length;
  const manifest = JSON.stringify({
    v: 3,
    compression: pack.compression,
    content_type: pack.contentType,
    k: chunkHashes.length,
    chunks: chunkHashes,
    ...(hasHashes ? { hashes: chunkHexHashes } : {}),
    total_size: pack.compressed.length,
    ...(hasFunctions ? { functions } : {}),
    ...(hasFunctions && fnHashes ? { fn_hashes: fnHashes } : {}),
  });
  return Buffer.concat([
    encodeHeader(Compression.NONE, ContentType.MANIFEST),
    Buffer.from(manifest, 'utf8'),
  ]);
}

/** Pack a JS function as a HYTE FUNCTION-type transaction payload. */
export async function packFunction(jsCode: Buffer): Promise<Buffer> {
  const compressed = Buffer.from(await gzip(jsCode, { level: 1 }));
  const header = encodeHeader(Compression.GZIP, ContentType.FUNCTION);
  return Buffer.concat([header, compressed]);
}
