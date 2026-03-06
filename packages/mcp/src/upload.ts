import { createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unzipSync } from 'fflate';
import {
  packFiles, wrapSingle, buildChunks, buildManifestPayload, CHUNK_SIZE,
} from './packFiles.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_UNCOMPRESSED = 30 * 1024 * 1024;  // 30 MB (images get filtered below)
const MAX_COMPRESSED   = 4 * 1024 * 1024;   // 4 MB compressed (~10 chunks max)
const MAX_CHUNKS       = 10;

// Skip large binary files that inflate size without adding readable content.
// Small images/icons (<100KB) are kept.
const LARGE_BINARY_EXT = /\.(png|jpe?g|gif|webp|mp4|mov|avi|wmv|pdf|zip|tar\.gz|woff2?|ttf|otf|eot)$/i;
const LARGE_BINARY_THRESHOLD = 100 * 1024; // 100 KB

// ---------------------------------------------------------------------------
// Rate limiter (in-memory, per Worker instance — good for basic abuse prevention)
// ---------------------------------------------------------------------------

const rlMap = new Map<string, number[]>();

function checkRateLimit(ip: string): boolean {
  const now  = Date.now();
  const hour = 3_600_000;
  const prev = (rlMap.get(ip) ?? []).filter(t => now - t < hour);
  if (prev.length >= 5) return false;
  rlMap.set(ip, [...prev, now]);
  return true;
}

// ---------------------------------------------------------------------------
// ZIP extraction
// ---------------------------------------------------------------------------

const SKIP = /^(node_modules\/|\.git\/|\.DS_Store$|__pycache__\/|\.env)/;

function extractZip(buffer: Buffer): { files: Map<string, Buffer>; skipped: number } {
  const raw   = unzipSync(new Uint8Array(buffer));
  const paths = Object.keys(raw).filter(k => !k.endsWith('/'));

  // Strip common root dir (e.g. "repo-main/") added by GitHub zips
  const roots      = [...new Set(paths.map(k => k.split('/')[0]))];
  const rootPrefix = roots.length === 1 ? roots[0] + '/' : '';

  // Prefer a build output dir if present
  const buildDirs = ['dist/', 'public/', 'build/', 'out/', '_site/', 'www/'];
  let prefix = rootPrefix;
  for (const dir of buildDirs) {
    if (paths.some(k => k.startsWith(rootPrefix + dir))) {
      prefix = rootPrefix + dir;
      break;
    }
  }

  const files = new Map<string, Buffer>();
  let skipped = 0;

  for (const [p, content] of Object.entries(raw)) {
    if (p.endsWith('/')) continue;
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (!rel || SKIP.test(rel)) continue;

    // Skip large binary files
    if (LARGE_BINARY_EXT.test(rel) && content.length > LARGE_BINARY_THRESHOLD) {
      skipped++;
      continue;
    }

    files.set(rel, Buffer.from(content));
  }

  return { files, skipped };
}

// ---------------------------------------------------------------------------
// GitHub fetch
// ---------------------------------------------------------------------------

export async function fetchGithubZip(input: string): Promise<Buffer> {
  const cleaned = input.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [repo, branch] = cleaned.split('@');
  if (!repo || !/^[^\/]+\/[^\/]+$/.test(repo)) {
    throw new Error('Invalid GitHub URL — expected github.com/owner/repo');
  }

  const branches = branch ? [branch] : ['main', 'master', 'gh-pages'];
  for (const b of branches) {
    const res = await fetch(`https://codeload.github.com/${repo}/zip/refs/heads/${b}`);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`Could not fetch ${repo} — is the repo public?`);
}

// ---------------------------------------------------------------------------
// Berachain publish
// ---------------------------------------------------------------------------

function makeWallet(env: Env) {
  const rpcUrl  = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
  const chain   = defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return createWalletClient({ account, chain, transport: http(rpcUrl) });
}

async function sendTx(data: Buffer, env: Env): Promise<`0x${string}`> {
  return makeWallet(env).sendTransaction({
    to:    '0x000000000000000000000000000000000000dEaD',
    data:  `0x${data.toString('hex')}`,
    value: 0n,
  });
}

// ---------------------------------------------------------------------------
// Env interface
// ---------------------------------------------------------------------------

export interface Env {
  BERACHAIN_RPC?: string;
  PRIVATE_KEY?:   string;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handlePublish(request: Request, env: Env, origin: string): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  if (!env.PRIVATE_KEY) return err(503, 'Service unavailable — publish key not configured');
  if (!checkRateLimit(ip)) return err(429, 'Rate limit: max 5 publishes per hour per IP');

  let files: Map<string, Buffer>;
  let skipped = 0;

  const ct = request.headers.get('Content-Type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) return err(400, 'Missing "file" field');
    if (!file.name.toLowerCase().endsWith('.zip')) return err(400, 'Only .zip files accepted');
    const result = extractZip(Buffer.from(await file.arrayBuffer()));
    files = result.files; skipped = result.skipped;
  } else {
    const body = await request.json() as { github?: string };
    if (!body.github) return err(400, 'Provide a zip upload or { "github": "owner/repo" }');
    const zip = await fetchGithubZip(body.github);
    const result = extractZip(zip);
    files = result.files; skipped = result.skipped;
  }

  if (files.size === 0) return err(400, 'No publishable files found');

  const totalBytes = [...files.values()].reduce((s, b) => s + b.length, 0);
  if (totalBytes > MAX_UNCOMPRESSED) {
    return err(413, `Site too large even after filtering: ${(totalBytes / 1_048_576).toFixed(1)} MB`);
  }

  const packed = await packFiles(files);

  if (packed.compressed.length > MAX_COMPRESSED) {
    return err(413, `Compressed size ${Math.round(packed.compressed.length / 1024)} KB exceeds ${MAX_COMPRESSED / 1024} KB limit`);
  }

  let txHash: `0x${string}`;

  if (packed.compressed.length <= CHUNK_SIZE) {
    // Single transaction
    txHash = await sendTx(wrapSingle(packed), env);
  } else {
    // Chunked: publish each chunk, then the manifest
    const numChunks = Math.ceil(packed.compressed.length / CHUNK_SIZE);
    if (numChunks > MAX_CHUNKS) {
      return err(413, `Would require ${numChunks} chunks (max ${MAX_CHUNKS})`);
    }

    const { chunks } = buildChunks(packed);
    const chunkHashes: string[] = [];
    for (const chunk of chunks) {
      chunkHashes.push(await sendTx(chunk, env));
    }
    const manifestPayload = buildManifestPayload(chunkHashes, packed);
    txHash = await sendTx(manifestPayload, env);
  }

  return new Response(JSON.stringify({
    txHash,
    gatewayUrl: `${origin}/${txHash}`,
    files: packed.fileCount,
    ...(skipped > 0 ? { skippedLargeFiles: skipped } : {}),
  }), { headers: { 'Content-Type': 'application/json' } });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
