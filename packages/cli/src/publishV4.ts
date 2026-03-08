/**
 * publishV4.ts — Manifest v4: per-file addressing with incremental deploy cache.
 *
 * Each file is published as an individual HYTE BLOB tx. The SHA-256 of the
 * raw (pre-compress) file content is used as the cache key so unchanged files
 * are never re-uploaded across deploys.
 *
 * Manifest v4 format:
 * {
 *   "v": 4,
 *   "files": {
 *     "index.html": { "tx": "0x...", "size": 1234, "sha256": "abc...",
 *                     "compression": 1, "mime": "text/html" }
 *   }
 * }
 */

import { createHash, randomBytes } from 'node:crypto';
import * as zlib from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { VERSION, Compression, ContentType, encodeHeader } from './format';
import type { PublishOptions } from './publish';

const gzip = promisify(zlib.gzip);

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css', js: 'application/javascript', mjs: 'application/javascript',
  json: 'application/json', xml: 'application/xml', txt: 'text/plain',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
  mp4: 'video/mp4', webm: 'video/webm',
  pdf: 'application/pdf',
};

function getMime(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Blob cache (~/.hybertext/blob-cache.json)
// SHA-256 of raw file content → tx hash
// ---------------------------------------------------------------------------

const CACHE_PATH = process.env.HYBERTEXT_CACHE_PATH
  ?? path.join(os.homedir(), '.hybertext', 'blob-cache.json');

function loadBlobCache(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveBlobCache(cache: Record<string, string>): void {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Collect files (excludes function files and dot-files)
// ---------------------------------------------------------------------------

const SKIP_RE = /^(node_modules\/|\.git\/|\.DS_Store$|__pycache__\/|functions\/.*\.js$|_worker\.js$)/;

function collectFiles(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function walk(cur: string): void {
    for (const name of fs.readdirSync(cur).sort()) {
      const full = path.join(cur, name);
      const rel  = path.relative(dir, full).split(path.sep).join('/');
      if (SKIP_RE.test(rel)) continue;
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else files.set(rel, fs.readFileSync(full));
    }
  }
  walk(dir);
  return files;
}

// ---------------------------------------------------------------------------
// Per-file HYTE BLOB publishing
// ---------------------------------------------------------------------------

const SINK = '0x000000000000000000000000000000000000dEaD' as const;

const berachain = defineChain({
  id: 80094,
  name: 'Berachain',
  nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.berachain.com'] } },
});

function makeClients(opts: PublishOptions) {
  const chain   = { ...berachain, rpcUrls: { default: { http: [opts.rpcUrl] } } };
  const account = privateKeyToAccount(opts.privateKey);
  return {
    wallet: createWalletClient({ account, chain, transport: http(opts.rpcUrl) }),
    pub:    createPublicClient({ chain, transport: http(opts.rpcUrl) }),
  };
}

async function sendBlob(
  content: Buffer,
  mime: string,
  wallet: ReturnType<typeof createWalletClient>,
  pub:    ReturnType<typeof createPublicClient>,
): Promise<`0x${string}`> {
  const compressed = Buffer.from(await gzip(content));
  const header     = encodeHeader({ version: VERSION, compression: Compression.GZIP, contentType: ContentType.BLOB });
  const payload    = Buffer.concat([header, compressed]);
  const hash       = await wallet.sendTransaction({
    to: SINK, value: 0n,
    data: `0x${payload.toString('hex')}` as `0x${string}`,
  });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

// HyberIndex ABI (for announce)
const INDEX_ABI = [{
  name: 'publish', type: 'function',
  inputs: [{ name: 'txHash', type: 'bytes32' }, { name: 'contentType', type: 'uint8' }],
  outputs: [], stateMutability: 'nonpayable',
}] as const;

// HyberDeployExecutor ABI (for --via)
const EXECUTOR_ABI = [{
  name: 'publishToIndex', type: 'function',
  inputs: [{ name: 'txHash', type: 'bytes32' }, { name: 'contentType', type: 'uint8' }, { name: 'indexAddress', type: 'address' }],
  outputs: [], stateMutability: 'nonpayable',
}] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

export async function publishDirectoryV4(
  dir:  string,
  opts: PublishOptions,
): Promise<`0x${string}`> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }

  const { wallet, pub } = makeClients(opts);
  const cache           = loadBlobCache();
  const files           = collectFiles(dir);
  const manifestFiles: Record<string, V4FileEntry> = {};

  let newUploads = 0;
  let cacheHits  = 0;

  console.log(`  ${files.size} file(s) to process...`);

  for (const [rel, content] of files) {
    const sha256 = createHash('sha256').update(content).digest('hex');
    let txHash   = cache[sha256] as `0x${string}` | undefined;

    if (txHash) {
      cacheHits++;
      process.stdout.write(`  ${rel} (cached)\n`);
    } else {
      process.stdout.write(`  ${rel}... `);
      txHash = await sendBlob(content, getMime(rel), wallet, pub);
      cache[sha256] = txHash;
      newUploads++;
      console.log(`done (${txHash.slice(0, 10)}...)`);
    }

    manifestFiles[rel] = {
      tx:          txHash,
      size:        content.length,
      sha256,
      compression: Compression.GZIP,
      mime:        getMime(rel),
    };
  }

  saveBlobCache(cache);

  if (cacheHits > 0) {
    console.log(`  ${cacheHits} file(s) from cache, ${newUploads} uploaded.`);
  }

  // Publish the manifest
  const manifest: ManifestV4 = { v: 4, files: manifestFiles };
  const manifestJson          = Buffer.from(JSON.stringify(manifest));
  const manifestHeader        = encodeHeader({ version: VERSION, compression: Compression.NONE, contentType: ContentType.MANIFEST });
  const manifestPayload       = Buffer.concat([manifestHeader, manifestJson]);

  process.stdout.write('  Publishing v4 manifest... ');
  const manifestHash = await wallet.sendTransaction({
    to: SINK, value: 0n,
    data: `0x${manifestPayload.toString('hex')}` as `0x${string}`,
  });
  await pub.waitForTransactionReceipt({ hash: manifestHash });
  console.log('done');

  // Announce to HyberIndex
  if (opts.indexAddress && opts.indexAddress !== '0x0000000000000000000000000000000000000000') {
    try {
      process.stdout.write('  Announcing to HyberIndex... ');
      let announceHash: `0x${string}`;
      if (opts.viaAddress) {
        announceHash = await wallet.writeContract({
          address: opts.viaAddress, abi: EXECUTOR_ABI, functionName: 'publishToIndex',
          args: [manifestHash, ContentType.MANIFEST, opts.indexAddress],
        });
      } else {
        announceHash = await wallet.writeContract({
          address: opts.indexAddress, abi: INDEX_ABI, functionName: 'publish',
          args: [manifestHash, ContentType.MANIFEST],
        });
      }
      await pub.waitForTransactionReceipt({ hash: announceHash });
      console.log('done');
    } catch (e: any) {
      console.log(`skipped (${e.message ?? 'error'})`);
    }
  }

  return manifestHash;
}
