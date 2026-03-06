import * as zlib from 'zlib';
import { promisify } from 'util';
import { pack as tarPack } from 'tar-stream';

const brotliCompress = promisify(zlib.brotliCompress);

const MAGIC      = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
const HEADER_SIZE = 9;

const Compression = { NONE: 0, GZIP: 1, BROTLI: 2 } as const;
const ContentType  = { HTML: 0, TAR: 1, MANIFEST: 2 } as const;

export const CHUNK_SIZE = 400 * 1024; // 400 KB

function encodeHeader(compression: number, contentType: number): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(h, 0);
  h[4] = 0x01; // version
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
  data: Buffer;          // full HYTE payload ready to use as tx calldata
  compressedSize: number;
  fileCount: number;
}

export async function packFiles(files: Map<string, Buffer>): Promise<PackResult> {
  // Single HTML file → ContentType.HTML
  const keys = [...files.keys()];
  const htmlOnly = files.size === 1 && keys[0].match(/\.html?$/i);

  const rawPayload = htmlOnly
    ? files.get(keys[0])!
    : await createTarBuffer(files);

  const contentType = htmlOnly ? ContentType.HTML : ContentType.TAR;
  const compressed  = Buffer.from(await brotliCompress(rawPayload, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
  }));
  const header      = encodeHeader(Compression.BROTLI, contentType);

  return {
    data: Buffer.concat([header, compressed]),
    compressedSize: compressed.length,
    fileCount: files.size,
  };
}
