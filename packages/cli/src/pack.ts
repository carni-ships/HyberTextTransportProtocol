import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { pack } from 'tar-stream';
import { Compression, ContentType } from './format';

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

export const CHUNK_SIZE = 400 * 1024; // 400KB per chunk

export interface PackResult {
  payload: Buffer;
  compression: number;
  contentType: number;
}

export async function packPath(inputPath: string): Promise<PackResult> {
  const stat = fs.statSync(inputPath);
  let raw: Buffer;
  let contentType: number;

  if (stat.isDirectory()) {
    raw = await packDirectory(inputPath);
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

async function packDirectory(dirPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const packer = pack();
    const chunks: Buffer[] = [];

    packer.on('data', (chunk: Buffer) => chunks.push(chunk));
    packer.on('end', () => resolve(Buffer.concat(chunks)));
    packer.on('error', reject);

    async function addEntry(filePath: string, entryName: string): Promise<void> {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        // Process directory entries sequentially — tar-stream has one active entry at a time
        for (const name of fs.readdirSync(filePath).sort()) {
          await addEntry(path.join(filePath, name), path.join(entryName, name));
        }
      } else {
        const content = fs.readFileSync(filePath);
        await new Promise<void>((res, rej) => {
          packer.entry({ name: entryName, size: content.length }, content, (err) =>
            err ? rej(err) : res()
          );
        });
      }
    }

    addEntry(dirPath, '.')
      .then(() => packer.finalize())
      .catch(reject);
  });
}

export function chunkBuffer(buf: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
    chunks.push(buf.subarray(i, Math.min(i + CHUNK_SIZE, buf.length)));
  }
  return chunks;
}
