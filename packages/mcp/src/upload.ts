import { createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unzipSync } from 'fflate';
import { packFiles, CHUNK_SIZE } from './packFiles.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_UNCOMPRESSED = 5 * 1024 * 1024;  // 5 MB
const MAX_COMPRESSED   = CHUNK_SIZE;         // 400 KB → single tx

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter: 5 publishes per IP per hour
// Resets on Worker cold-start — good enough for abuse prevention
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

// Skip files that shouldn't be published
const SKIP = /^(node_modules\/|\.git\/|\.DS_Store$|__pycache__\/)/;

function extractZip(buffer: Buffer): Map<string, Buffer> {
  const raw   = unzipSync(new Uint8Array(buffer));
  const paths = Object.keys(raw).filter(k => !k.endsWith('/'));

  // Strip common root dir (e.g. "repo-main/") added by GitHub zips
  const roots    = [...new Set(paths.map(k => k.split('/')[0]))];
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
  for (const [p, content] of Object.entries(raw)) {
    if (p.endsWith('/')) continue;
    if (!p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (!rel || SKIP.test(rel)) continue;
    files.set(rel, Buffer.from(content));
  }
  return files;
}

// ---------------------------------------------------------------------------
// GitHub fetch
// ---------------------------------------------------------------------------

export async function fetchGithubZip(input: string): Promise<Buffer> {
  // Accept: github.com/owner/repo, owner/repo, owner/repo@branch
  const cleaned = input.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const [repo, branch] = cleaned.split('@');
  if (!repo || !/^[^\/]+\/[^\/]+$/.test(repo)) {
    throw new Error('Invalid GitHub URL — expected github.com/owner/repo');
  }

  const branches = branch ? [branch] : ['main', 'master'];
  for (const b of branches) {
    const res = await fetch(`https://codeload.github.com/${repo}/zip/refs/heads/${b}`);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`Could not fetch ${repo} — is the repo public and does the branch exist?`);
}

// ---------------------------------------------------------------------------
// Berachain publish
// ---------------------------------------------------------------------------

async function publishToChain(data: Buffer, env: Env): Promise<`0x${string}`> {
  const rpcUrl  = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
  const chain   = defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  return wallet.sendTransaction({
    to:    '0x000000000000000000000000000000000000dEaD',
    data:  `0x${data.toString('hex')}`,
    value: 0n,
  });
}

// ---------------------------------------------------------------------------
// Env interface (shared with worker.ts)
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

  if (!env.PRIVATE_KEY) {
    return err(503, 'Service unavailable — publish key not configured');
  }
  if (!checkRateLimit(ip)) {
    return err(429, 'Rate limit: max 5 publishes per hour per IP');
  }

  let files: Map<string, Buffer>;

  const ct = request.headers.get('Content-Type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) return err(400, 'Missing "file" field');
    if (!file.name.toLowerCase().endsWith('.zip')) return err(400, 'Only .zip files accepted');
    files = extractZip(Buffer.from(await file.arrayBuffer()));
  } else {
    const body = await request.json() as { github?: string };
    if (!body.github) return err(400, 'Provide a zip upload or { "github": "owner/repo" }');
    const zip = await fetchGithubZip(body.github);
    files = extractZip(zip);
  }

  if (files.size === 0) {
    return err(400, 'No publishable files found — check the zip contents or repo structure');
  }

  const totalBytes = [...files.values()].reduce((s, b) => s + b.length, 0);
  if (totalBytes > MAX_UNCOMPRESSED) {
    return err(413, `Site too large: ${(totalBytes / 1_048_576).toFixed(1)} MB (max 5 MB)`);
  }

  const packed = await packFiles(files);
  if (packed.compressedSize > MAX_COMPRESSED) {
    return err(413, `Compressed size ${Math.round(packed.compressedSize / 1024)} KB exceeds 400 KB limit`);
  }

  const txHash    = await publishToChain(packed.data, env);
  const gatewayUrl = `${origin}/${txHash}`;

  return new Response(JSON.stringify({ txHash, gatewayUrl, files: packed.fileCount }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
