import { createHash } from 'node:crypto';
import { createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unzip } from 'fflate';
import {
  packFiles, packFunction, wrapSingle, buildChunks, buildManifestPayload, CHUNK_SIZE,
} from './packFiles.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_UNCOMPRESSED = 30 * 1024 * 1024;  // 30 MB (images get filtered below)
const MAX_COMPRESSED   = 4 * 1024 * 1024;   // 4 MB compressed (~40 chunks max)
const MAX_CHUNKS       = 40;
const MAX_ZIP_SIZE     = 3 * 1024 * 1024;   // 3 MB zip — larger zips exceed Worker CPU limits
const MAX_FUNCTIONS    = 5;                  // max number of edge functions per site

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

function extractZip(buffer: Buffer): Promise<{ files: Map<string, Buffer>; fnFiles: Map<string, Buffer>; skipped: number }> {
  return new Promise((resolve, reject) => {
    unzip(new Uint8Array(buffer), (err, raw) => {
      if (err) { reject(err); return; }

      const paths      = Object.keys(raw).filter(k => !k.endsWith('/'));
      const roots      = [...new Set(paths.map(k => k.split('/')[0]))];
      const rootPrefix = roots.length === 1 ? roots[0] + '/' : '';

      const buildDirs = ['dist/', 'public/', 'build/', 'out/', '_site/', 'www/'];
      let prefix = rootPrefix;
      for (const dir of buildDirs) {
        if (paths.some(k => k.startsWith(rootPrefix + dir))) {
          prefix = rootPrefix + dir;
          break;
        }
      }

      const files   = new Map<string, Buffer>();
      const fnFiles = new Map<string, Buffer>();
      let skipped = 0;

      for (const [p, content] of Object.entries(raw)) {
        if (p.endsWith('/')) continue;
        if (!p.startsWith(prefix)) continue;
        const rel = p.slice(prefix.length);
        if (!rel || SKIP.test(rel)) continue;

        // Detect function files: functions/*.js or _worker.js
        if (rel === '_worker.js') {
          fnFiles.set('_worker', Buffer.from(content));
          continue;
        }
        if (rel.startsWith('functions/') && rel.endsWith('.js')) {
          // Strip "functions/" prefix and ".js" suffix to get the route key
          const routeKey = rel.slice('functions/'.length, -'.js'.length);
          if (routeKey) {
            fnFiles.set(routeKey, Buffer.from(content));
            continue;
          }
        }

        if (LARGE_BINARY_EXT.test(rel) && content.length > LARGE_BINARY_THRESHOLD) {
          skipped++; continue;
        }
        files.set(rel, Buffer.from(content));
      }

      resolve({ files, fnFiles, skipped });
    });
  });
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
    if (!res.ok) continue;
    // Check Content-Length before downloading to fail fast on huge zips
    const cl = res.headers.get('Content-Length');
    if (cl && parseInt(cl) > MAX_ZIP_SIZE) {
      throw new Error(`Repository ZIP is ${(parseInt(cl) / 1_048_576).toFixed(1)} MB — too large to process (max ${MAX_ZIP_SIZE / 1_048_576} MB). For larger sites, use the CLI.`);
    }
    return Buffer.from(await res.arrayBuffer());
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
  return createWalletClient({ account, chain, transport: http(rpcUrl, { batch: false }) });
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

interface TxContext { rpcUrl: string; wallet: ReturnType<typeof makeWallet>; nonce: number; gasPrice: bigint; }

// ---------------------------------------------------------------------------
// KV nonce reservation
//
// Problem: multiple Worker invocations publishing simultaneously all call
// eth_getTransactionCount and receive the same pending nonce, so all but one
// transaction fail with "replacement transaction underpriced".
//
// Fix: maintain a per-wallet nonce counter in KV.  Each invocation reads the
// counter, increments it (claiming the old value), and writes back — all
// before touching the RPC.  Cloudflare KV provides read-after-write
// consistency within the same PoP, so concurrent requests at the same edge
// location each receive a distinct nonce.
//
// The on-chain `eth_getTransactionCount(...,'pending')` value serves as a
// floor: if the KV counter has drifted behind (e.g. a tx was dropped or the
// counter expired), we reset to the chain's pending nonce so we never submit
// a nonce that would be permanently stuck.
// ---------------------------------------------------------------------------

const NONCE_KV_TTL = 300; // 5 min — well above Berachain's ~2s block time

async function reserveNonce(kv: any, rpcUrl: string, address: string): Promise<number> {
  const KEY = `nonce:counter:${address.toLowerCase()}`;

  // Fetch on-chain pending nonce and gas price in parallel.
  const pendingHex = await rpcCall(rpcUrl, 'eth_getTransactionCount', [address, 'pending']);
  const onChain    = parseInt(pendingHex as string, 16);

  if (!kv) return onChain; // no KV configured — fall back to original behavior

  const raw = await kv.get(KEY);
  let nonce = onChain;

  if (raw) {
    const stored = JSON.parse(raw) as { n: number; updatedAt: number };
    const ageMs  = Date.now() - stored.updatedAt;
    // Use KV counter only if it's fresh (< 2 min) and ahead of the chain.
    // If it has fallen behind the chain's pending count, the chain wins —
    // this self-heals after a dropped or stuck transaction.
    if (ageMs < 120_000 && stored.n > onChain) {
      nonce = stored.n;
    }
  }

  // Claim `nonce`, write `nonce + 1` for the next caller.
  await kv.put(KEY, JSON.stringify({ n: nonce + 1, updatedAt: Date.now() }), {
    expirationTtl: NONCE_KV_TTL,
  });

  return nonce;
}

async function makeTxContext(env: Env): Promise<TxContext> {
  const rpcUrl = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const wallet = makeWallet(env);
  const kv     = (env as any).EDGE_KV ?? null;

  // Reserve nonce via KV + fetch gas price in parallel.
  const [nonce, gasPriceHex] = await Promise.all([
    reserveNonce(kv, rpcUrl, wallet.account.address),
    rpcCall(rpcUrl, 'eth_gasPrice', []),
  ]);

  return { rpcUrl, wallet, nonce, gasPrice: BigInt(gasPriceHex as string) };
}

async function sendTx(data: Buffer, ctx: TxContext): Promise<`0x${string}`> {
  const gas   = BigInt((21_000 + data.length * 30) * 4);
  const nonce = ctx.nonce++;
  return ctx.wallet.sendTransaction({
    to:       '0x000000000000000000000000000000000000dEaD',
    data:     `0x${data.toString('hex')}`,
    value:    0n,
    gas,
    gasPrice: ctx.gasPrice,
    nonce,
  });
}

// ---------------------------------------------------------------------------
// Env interface
// ---------------------------------------------------------------------------

export interface Env {
  BERACHAIN_RPC?:          string;
  /** Comma-separated fallback RPC URLs tried in order when BERACHAIN_RPC fails. */
  RPC_FALLBACKS?:          string;
  PRIVATE_KEY?:            string;
  BASE_DOMAIN?:            string;
  REGISTRY_ADDRESS?:       string;
  HYBERDB_ADDRESS?:        string;
  HYBERINDEX_ADDRESS?:     string;
  /** Earliest block to scan when querying HyberIndex events (hex or decimal).
   *  Set to the block HyberIndex was deployed at to avoid scanning from genesis. */
  HYBERINDEX_FROM_BLOCK?:  string;
  // Vault / encrypted sites
  ACP_ADDRESS?:            string;   // HyberACP contract address (ERC-8183)
  AGENT_IDENTITY_ADDRESS?:    string;   // HyberAgentIdentity contract address (ERC-8004)
  AGENT_REPUTATION_ADDRESS?:  string;   // HyberAgentReputation contract address (ERC-8004)
  ACP_REP_HOOK_ADDRESS?:      string;   // HyberACPRepHook — ERC-8183 × ERC-8004 hook
  VAULT_ADDRESS?:          string;   // HyberKeyVault contract address
  VAULT_X25519_PUBKEY?:    string;   // 32-byte hex — exposed via GET /vault/pubkey
  VAULT_X25519_PRIVKEY?:   string;   // 32-byte hex secret — never exposed
  PAYMENT_SESSIONS_KV?:    KVNamespace;
  PAYMENT_USED_KV?:        KVNamespace;
  /** KV namespace injected into edge functions as env.kv */
  EDGE_KV?:                KVNamespace;
}

// Forward-declare KVNamespace so upload.ts doesn't need to import x402.ts
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handlePublish(request: Request, env: Env, origin: string): Promise<Response> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';

  if (!env.PRIVATE_KEY) return err(503, 'Service unavailable — publish key not configured');
  if (!checkRateLimit(ip)) return err(429, 'Rate limit: max 5 publishes per hour per IP');

  let files: Map<string, Buffer>;
  let fnFiles: Map<string, Buffer>;
  let skipped = 0;

  const ct = request.headers.get('Content-Type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file') as File | null;
    if (!file) return err(400, 'Missing "file" field');
    if (!file.name.toLowerCase().endsWith('.zip')) return err(400, 'Only .zip files accepted');
    const zipBuf = Buffer.from(await file.arrayBuffer());
    if (zipBuf.length > MAX_ZIP_SIZE) {
      return err(413, `ZIP is ${(zipBuf.length / 1_048_576).toFixed(1)} MB — too large to process (max ${MAX_ZIP_SIZE / 1_048_576} MB). For larger sites, use the CLI.`);
    }
    const result = await extractZip(zipBuf);
    files = result.files; fnFiles = result.fnFiles; skipped = result.skipped;
  } else {
    const body = await request.json() as { github?: string };
    if (!body.github) return err(400, 'Provide a zip upload or { "github": "owner/repo" }');
    const zip = await fetchGithubZip(body.github);
    if (zip.length > MAX_ZIP_SIZE) {
      return err(413, `Repository ZIP is ${(zip.length / 1_048_576).toFixed(1)} MB — too large to process (max ${MAX_ZIP_SIZE / 1_048_576} MB). For larger sites, use the CLI.`);
    }
    const result = await extractZip(zip);
    files = result.files; fnFiles = result.fnFiles; skipped = result.skipped;
  }

  if (files.size === 0) return err(400, 'No publishable files found');

  if (fnFiles.size > MAX_FUNCTIONS) {
    return err(413, `Too many function files: ${fnFiles.size} (max ${MAX_FUNCTIONS})`);
  }

  const totalBytes = [...files.values()].reduce((s, b) => s + b.length, 0);
  if (totalBytes > MAX_UNCOMPRESSED) {
    return err(413, `Site too large even after filtering: ${(totalBytes / 1_048_576).toFixed(1)} MB`);
  }

  const packed = await packFiles(files);

  if (packed.compressed.length > MAX_COMPRESSED) {
    return err(413, `Compressed size ${Math.round(packed.compressed.length / 1024)} KB exceeds ${MAX_COMPRESSED / 1024} KB limit`);
  }

  let txHash: `0x${string}`;
  const ctx = await makeTxContext(env);

  // Publish each function file as a FUNCTION-type HYTE tx
  const functionHashes: Record<string, string> = {};
  const fnHashes:       Record<string, string> = {};
  for (const [routeKey, jsCode] of fnFiles) {
    const fnPayload = await packFunction(jsCode);
    const fnTxHash  = await sendTx(fnPayload, ctx);
    functionHashes[routeKey] = fnTxHash;
    fnHashes[routeKey]       = sha256hex(fnPayload);
  }

  const hasFunctions = Object.keys(functionHashes).length > 0;

  // If there are functions, or the payload requires chunking, use manifest format
  if (packed.compressed.length <= CHUNK_SIZE && !hasFunctions) {
    // Single transaction — no functions, fits in one chunk
    txHash = await sendTx(wrapSingle(packed), ctx);
  } else {
    // Chunked: publish each chunk with sha256 hash, then the v3 manifest
    const numChunks = Math.ceil(packed.compressed.length / CHUNK_SIZE);
    if (numChunks > MAX_CHUNKS) {
      return err(413, `Would require ${numChunks} chunks (max ${MAX_CHUNKS})`);
    }

    const { chunks } = buildChunks(packed);
    const chunkTxHashes: string[]  = [];
    const chunkSha256:   string[]  = [];
    for (const chunk of chunks) {
      chunkTxHashes.push(await sendTx(chunk, ctx));
      chunkSha256.push(sha256hex(chunk));
    }
    const manifestPayload = buildManifestPayload(
      chunkTxHashes,
      packed,
      hasFunctions ? functionHashes : undefined,
      chunkSha256,
      hasFunctions ? fnHashes : undefined,
    );
    txHash = await sendTx(manifestPayload, ctx);
  }

  // Announce to HyberIndex (fire-and-forget — non-critical)
  announceIndex(txHash, env).catch(() => { /* ignore */ });

  return new Response(JSON.stringify({
    txHash,
    gatewayUrl: `${origin}/${txHash}`,
    files: packed.fileCount,
    ...(hasFunctions ? { functions: Object.keys(functionHashes).length } : {}),
    ...(skipped > 0 ? { skippedLargeFiles: skipped } : {}),
  }), { headers: { 'Content-Type': 'application/json' } });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// HyberIndex ABI: publish(bytes32 txHash, uint8 contentType)
// Manually ABI-encoded since we don't want to spin up a full viem client just for this.
// Selector: cast sig "publish(bytes32,uint8)" = 0x65b38482
const HYBERINDEX_PUBLISH_SELECTOR = '65b38482';

/**
 * Publish a single HTML (or any text) file as a HyberText site.
 * Used by MCP tools to bypass the HTTP multipart flow.
 */
export async function publishHtml(
  content: string,
  filename: string,
  env: Env,
  origin: string,
): Promise<{ txHash: string; gatewayUrl: string }> {
  if (!env.PRIVATE_KEY) throw new Error('PRIVATE_KEY not configured');
  const files = new Map([[filename, Buffer.from(content, 'utf8')]]);
  const packed = await packFiles(files);
  const ctx    = await makeTxContext(env);
  let txHash: `0x${string}`;

  if (packed.compressed.length <= CHUNK_SIZE) {
    txHash = await sendTx(wrapSingle(packed), ctx);
  } else {
    const numChunks = Math.ceil(packed.compressed.length / CHUNK_SIZE);
    if (numChunks > MAX_CHUNKS) throw new Error(`Content too large — would require ${numChunks} chunks (max ${MAX_CHUNKS})`);
    const { chunks } = buildChunks(packed);
    const chunkTxHashes: string[] = [];
    const chunkSha256:   string[] = [];
    for (const chunk of chunks) {
      chunkTxHashes.push(await sendTx(chunk, ctx));
      chunkSha256.push(sha256hex(chunk));
    }
    txHash = await sendTx(buildManifestPayload(chunkTxHashes, packed, undefined, chunkSha256), ctx);
  }

  announceIndex(txHash, env).catch(() => { /* non-fatal */ });
  return { txHash, gatewayUrl: `${origin}/${txHash}/` };
}

async function announceIndex(txHash: `0x${string}`, env: Env): Promise<void> {
  const indexAddr = env.HYBERINDEX_ADDRESS;
  if (!indexAddr || indexAddr === '0x0000000000000000000000000000000000000000') return;
  if (!env.PRIVATE_KEY || !env.BERACHAIN_RPC) return;

  // ABI encode: publish(bytes32, uint8)
  // Layout: [4-byte selector][32-byte txHash (bytes32)][32-byte contentType (uint8 padded)]
  const rpcUrl  = env.BERACHAIN_RPC;
  const calldata = '0x'
    + HYBERINDEX_PUBLISH_SELECTOR
    + txHash.slice(2).padStart(64, '0')    // bytes32
    + '0000000000000000000000000000000000000000000000000000000000000002'; // uint8(2) = MANIFEST

  const nonceHex    = await (await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionCount', params: [makeWallet(env).account.address, 'pending'], id: 1 }),
  })).json().then((r: any) => r.result as string);
  const gasPriceHex = await (await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_gasPrice', params: [], id: 1 }),
  })).json().then((r: any) => r.result as string);

  const wallet = makeWallet(env);
  await wallet.sendTransaction({
    to:       indexAddr as `0x${string}`,
    data:     calldata as `0x${string}`,
    value:    0n,
    gas:      80_000n,
    gasPrice: BigInt(gasPriceHex),
    nonce:    parseInt(nonceHex, 16),
  });
}
