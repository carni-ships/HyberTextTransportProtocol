import { extract } from 'tar-stream';
import { Readable } from 'stream';
import { lookup } from 'mime-types';
import { ContentType } from './format';

export interface SiteFiles {
  contentType: number;
  files: Map<string, Buffer>; // normalized path → content
}

export async function extractSite(decoded: {
  contentType: number;
  payload: Buffer;
}): Promise<SiteFiles> {
  if (decoded.contentType === ContentType.HTML) {
    return {
      contentType: ContentType.HTML,
      files: new Map([['index.html', decoded.payload]]),
    };
  }

  // TAR: extract all files into memory
  const files = await extractTar(decoded.payload);
  return { contentType: ContentType.TAR, files };
}

async function extractTar(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const files = new Map<string, Buffer>();
    const extractor = extract();

    extractor.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (header.type === 'file') {
          files.set(normalizePath(header.name), Buffer.concat(chunks));
        }
        next();
      });
      stream.on('error', reject);
    });

    extractor.on('finish', () => resolve(files));
    extractor.on('error', reject);

    const readable = new Readable();
    readable.push(buf);
    readable.push(null);
    readable.pipe(extractor);
  });
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

export interface ServeResult {
  content: Buffer;
  mimeType: string;
}

export function resolveFile(files: Map<string, Buffer>, requestPath: string): ServeResult | null {
  // Normalize: strip leading slash, default to index.html
  let p = requestPath.replace(/^\//, '') || 'index.html';

  // Direct match
  if (files.has(p)) {
    return { content: files.get(p)!, mimeType: lookup(p) || 'application/octet-stream' };
  }

  // Directory index: /about → /about/index.html
  const withIndex = `${p.replace(/\/$/, '')}/index.html`;
  if (files.has(withIndex)) {
    return { content: files.get(withIndex)!, mimeType: 'text/html' };
  }

  return null;
}
