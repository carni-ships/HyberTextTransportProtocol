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
  const files = extractTar(decoded.payload);
  return { contentType: ContentType.TAR, files };
}

/** Pure buffer-based POSIX ustar tar extractor — no Node.js streams required. */
function extractTar(buf: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const BLOCK = 512;
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);

    // End of archive: two consecutive zero blocks
    if (header.every(b => b === 0)) break;

    const nameRaw = header.subarray(0, 100).toString('ascii').replace(/\0+$/, '');
    const prefix  = header.subarray(345, 500).toString('ascii').replace(/\0+$/, '');
    const fullName = prefix ? `${prefix}/${nameRaw}` : nameRaw;

    // Parse size: standard octal or GNU base-256 (high bit set)
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

    // typeFlag 0 or 0x30 = regular file; skip dirs, symlinks, GNU long-name blocks
    const isRegularFile = typeFlag === 0 || typeFlag === 0x30;
    if (isRegularFile && size > 0 && fullName) {
      const p = fullName.replace(/^\.\//, '').replace(/^\//, '');
      if (p) files.set(p, buf.subarray(offset, offset + size));
    }

    offset += Math.ceil(size / BLOCK) * BLOCK;
  }

  return files;
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

  // SPA fallback: extensionless paths → try 404.html, then index.html
  const hasExt = p.includes('.') && !p.endsWith('/');
  if (!hasExt) {
    const fallback = files.get('404.html') ?? files.get('index.html');
    if (fallback) {
      return { content: fallback, mimeType: 'text/html' };
    }
  }

  return null;
}
