import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Compression, ContentType, VERSION, encodeHeader } from './format';

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

export const CHUNK_SIZE = 100 * 1024; // 100 KB per chunk (matches Worker calldata limit)

export interface PackResult {
  payload: Buffer;
  compression: number;
  contentType: number;
}

/** Paths excluded from the static TAR — published as FUNCTION txs instead. */
const IS_FUNCTION = (rel: string) =>
  rel === '_worker.js' || rel.startsWith('functions/') && rel.endsWith('.js');

export async function packPath(inputPath: string): Promise<PackResult> {
  const stat = fs.statSync(inputPath);
  let raw: Buffer;
  let contentType: number;

  if (stat.isDirectory()) {
    // Exclude function files from the static TAR
    const allFiles = collectFiles(inputPath, inputPath);
    for (const key of allFiles.keys()) {
      if (IS_FUNCTION(key)) allFiles.delete(key);
    }
    raw = createTarBuffer(allFiles);
    contentType = ContentType.TAR;
  } else {
    raw = fs.readFileSync(inputPath);
    contentType = ContentType.HTML;
  }

  // Try brotli first (best compression for HTML/CSS/JS), fall back to gzip
  try {
    const compressed = await brotliCompress(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    });
    return { payload: Buffer.from(compressed), compression: Compression.BROTLI, contentType };
  } catch {
    const compressed = await gzipCompress(raw);
    return { payload: Buffer.from(compressed), compression: Compression.GZIP, contentType };
  }
}

/**
 * Scan a directory for edge function files.
 * Returns a Map<routeKey, jsCodeBuffer> where routeKey is:
 *   _worker.js         → '_worker'
 *   functions/api/hello.js → 'api/hello'
 */
export function detectFunctions(dirPath: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return out;

  const workerPath = path.join(dirPath, '_worker.js');
  if (fs.existsSync(workerPath)) {
    out.set('_worker', fs.readFileSync(workerPath));
  }

  const fnDir = path.join(dirPath, 'functions');
  if (fs.existsSync(fnDir) && fs.statSync(fnDir).isDirectory()) {
    (function walk(cur: string) {
      for (const name of fs.readdirSync(cur).sort()) {
        const full = path.join(cur, name);
        if (fs.statSync(full).isDirectory()) {
          walk(full);
        } else if (name.endsWith('.js')) {
          const rel = path.relative(fnDir, full).split(path.sep).join('/');
          out.set(rel.slice(0, -3), fs.readFileSync(full)); // strip .js
        }
      }
    })(fnDir);
  }

  return out;
}

/** Pack a JS function as a HYTE FUNCTION-type transaction payload. */
export async function packFunctionCode(jsCode: Buffer): Promise<Buffer> {
  try {
    const compressed = Buffer.from(await brotliCompress(jsCode, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }));
    return Buffer.concat([
      encodeHeader({ version: VERSION, compression: Compression.BROTLI, contentType: ContentType.FUNCTION }),
      compressed,
    ]);
  } catch {
    const compressed = Buffer.from(await gzipCompress(jsCode));
    return Buffer.concat([
      encodeHeader({ version: VERSION, compression: Compression.GZIP, contentType: ContentType.FUNCTION }),
      compressed,
    ]);
  }
}

/** Collect all files under dirPath into a Map<relPath, Buffer>, sorted for reproducibility. */
function collectFiles(baseDir: string, dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();

  function walk(current: string): void {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        // Use forward-slash paths in the tar, relative to baseDir
        const rel = path.relative(baseDir, full).split(path.sep).join('/');
        files.set(rel, fs.readFileSync(full));
      }
    }
  }

  walk(dir);
  return files;
}

/** Pure buffer-based POSIX ustar tar creator — no Node.js streams required. */
function createTarBuffer(files: Map<string, Buffer>): Buffer {
  const BLOCK = 512;
  const blocks: Buffer[] = [];

  for (const [name, content] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const header = Buffer.alloc(BLOCK);

    nameBytes.copy(header, 0, 0, Math.min(nameBytes.length, 99));
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 'ascii');
    header[156] = 0x30; // regular file
    header.write('ustar\0', 257, 'ascii');
    header.write('00', 263, 'ascii');

    // Checksum: fill field with spaces, compute sum, write back
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += header[i];
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');

    blocks.push(header);

    const padded = Buffer.alloc(Math.ceil(content.length / BLOCK) * BLOCK);
    content.copy(padded);
    if (padded.length > 0) blocks.push(padded);
  }

  // End-of-archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export function chunkBuffer(buf: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
    chunks.push(buf.subarray(i, Math.min(i + CHUNK_SIZE, buf.length)));
  }
  return chunks;
}
