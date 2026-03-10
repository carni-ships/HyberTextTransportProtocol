import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './createServer.js';
import { resolveSite, resolveFunctionCode, extractTar, decompress, fetchTxInput, ContentType, type ResolveSiteResult, type ManifestV4, type V4FileEntry } from './resolver.js';
import { parseRedirects, parseHeaders, applyRewrites } from './rewrites.js';
import { handlePublish, type Env } from './upload.js';
import { landingPage } from './landing.js';
import {
  CompositeResolver,
  HyberRegistryResolver,
  ENSResolver,
  BeranamesResolver,
} from './aliases.js';
import { handleDbRequest, warmDbCache } from '@hybertext/db';
import { handleTaskboardApi } from './taskboard-api.js';
import { linearPage } from './linear.js';
import {
  fetchVaultRecord,
  unwrapCEK,
  decryptPayload as vaultDecrypt,
  getVaultPublicKey,
} from './vault.js';
import {
  make402Response,
  verifyPayment,
  issueSession,
  checkSession,
  parseSessionCookie,
  type KVNamespace,
} from './x402.js';

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

function mimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    css:  'text/css',
    js:   'application/javascript',
    mjs:  'application/javascript',
    json: 'application/json',
    svg:  'image/svg+xml',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    gif:  'image/gif',
    webp: 'image/webp',
    ico:  'image/x-icon',
    woff: 'font/woff',
    woff2:'font/woff2',
    txt:  'text/plain',
  };
  return map[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Function route matching
// ---------------------------------------------------------------------------

/**
 * Match a URL path against a pattern that may contain [param] and [...rest] segments.
 * Returns a params object on match, null otherwise.
 */
function matchFunctionRoute(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts    = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const seg = patternParts[i];

    // [...rest] — captures remaining path segments
    if (seg.startsWith('[...') && seg.endsWith(']')) {
      const key = seg.slice(4, -1);
      params[key] = pathParts.slice(i).join('/');
      return params;
    }

    // [param] — captures a single segment
    if (seg.startsWith('[') && seg.endsWith(']')) {
      if (i >= pathParts.length) return null;
      params[seg.slice(1, -1)] = pathParts[i];
      continue;
    }

    // Literal segment — must match exactly
    if (pathParts[i] !== seg) return null;
  }

  // Pattern consumed — path must also be fully consumed (unless last seg was [...rest])
  if (pathParts.length !== patternParts.length) return null;

  return params;
}

// ---------------------------------------------------------------------------
// Function code cache (cold-start optimisation)
// ---------------------------------------------------------------------------

/**
 * Fetch function JS via chain, with a KV read-through cache keyed by txHash.
 * Cold start (no cache): ~100-300ms RPC round-trip.
 * Warm start (KV hit):   ~1-5ms.
 * TTL is 24h — sufficient since HYTE tx calldata is immutable.
 */
async function resolveWithCache(
  fnTxHash: string,
  rpcUrl: string | string[],
  expectedHash: string | undefined,
  kv: KVNamespace | undefined,
): Promise<string> {
  const cacheKey = `__hyber_fn:${fnTxHash}`;

  if (kv) {
    const cached = await kv.get(cacheKey);
    if (cached) return cached;
  }

  const code = await resolveFunctionCode(fnTxHash as `0x${string}`, rpcUrl, expectedHash);

  // Write-behind — don't await so the response isn't delayed
  if (kv) kv.put(cacheKey, code, { expirationTtl: 86400 }).catch(() => {});

  return code;
}

// ---------------------------------------------------------------------------
// Function URL proxy (no eval required)
// ---------------------------------------------------------------------------

/**
 * Look up a Cloudflare Service Binding for a function URL.
 *
 * Cloudflare Workers cannot fetch() to *.workers.dev URLs (error 1042).
 * Gateway operators must declare a service binding for each function Worker:
 *   [[services]]
 *   binding = "FN_{WORKER_NAME_UPPERCASED_WITH_UNDERSCORES}"
 *   service = "{worker-name}"
 *
 * For example, a worker named "hybertext-demo-fn" maps to binding "FN_HYBERTEXT_DEMO_FN".
 */
function getServiceBinding(
  env: Record<string, unknown> | undefined,
  fnUrl: string,
): { fetch: (r: Request) => Promise<Response> } | null {
  if (!env) return null;
  try {
    const hostname = new URL(fnUrl).hostname; // e.g. hybertext-demo-fn.carnation-903.workers.dev
    const workerName = hostname.split('.')[0];  // e.g. hybertext-demo-fn
    const bindingKey = 'FN_' + workerName.toUpperCase().replace(/-/g, '_'); // FN_HYBERTEXT_DEMO_FN
    const binding = env[bindingKey];
    if (binding && typeof (binding as any).fetch === 'function') {
      return binding as { fetch: (r: Request) => Promise<Response> };
    }
  } catch { /* ignore URL parse errors */ }
  return null;
}

/**
 * Proxy a request to a pre-deployed function Worker URL.
 * Uses a Cloudflare Service Binding when available (required for *.workers.dev targets).
 * Falls back to a public fetch for custom-domain function workers.
 */
async function proxyToFunctionUrl(
  fnUrl: string,
  request: Request,
  workerEnv?: Record<string, unknown>,
): Promise<Response> {
  const incoming = new URL(request.url);
  const target   = new URL(fnUrl);
  // Forward the full path so the function sees /api/info etc.
  target.pathname = incoming.pathname;
  target.search   = incoming.search;

  // Use a Service Binding if one is declared for this worker (avoids CF error 1042).
  const binding = getServiceBinding(workerEnv, fnUrl);
  if (binding) {
    const bound = new Request(target.toString(), {
      method:  request.method,
      headers: request.headers,
      body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    });
    return binding.fetch(bound);
  }

  // Build forwarded headers — omit Host to let fetch set the correct one
  // for the target origin. Passing the original Host causes a routing loop.
  const fwdHeaders = new Headers();
  request.headers.forEach((v, k) => {
    if (k.toLowerCase() !== 'host') fwdHeaders.set(k, v);
  });

  return fetch(target.toString(), {
    method:  request.method,
    headers: fwdHeaders,
    body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
  });
}

// ---------------------------------------------------------------------------
// Function execution (requires unsafe_eval)
// ---------------------------------------------------------------------------

async function callFunction(
  fnTxHash: string,
  params: Record<string, string>,
  request: Request,
  rpcUrl: string | string[],
  expectedHash?: string,
  workerEnv?: Env,
): Promise<Response> {
  const code = await resolveWithCache(fnTxHash, rpcUrl, expectedHash, workerEnv?.EDGE_KV as KVNamespace | undefined);

  let handler: Record<string, unknown> | ((...args: unknown[]) => unknown) | null | undefined;

  try {
    // Execute using new Function — requires "unsafe_eval" in compatibility_flags.
    // The function module is expected to export a fetch handler:
    //   export default { async fetch(request, env) { ... } }
    //   OR: module.exports = { fetch(request, env) { ... } }
    //   OR: module.exports = async function(request, env) { ... }
    // eslint-disable-next-line no-new-func
    const factory = new Function('module', 'exports', code + '\n;return module.exports;');
    const cjsMod: { exports?: unknown } = {};
    const cjsExports: Record<string, unknown> = {};
    handler = factory(cjsMod, cjsExports) as typeof handler;
  } catch (e: any) {
    return new Response(`Function load failed: ${e.message}`, { status: 500 });
  }

  const fn =
    (handler as any)?.default?.fetch ??
    (handler as any)?.fetch ??
    (typeof handler === 'function' ? handler : null);

  if (typeof fn !== 'function') {
    return new Response('Function has no fetch export', { status: 500 });
  }

  // Build the env object that is passed to the function as its second argument.
  // env.db  — HyberDBClient (if HYBERDB_ADDRESS is configured on the gateway)
  // env.kv  — Cloudflare KV namespace (if EDGE_KV binding is configured)
  // env.tableland — simple SQL query wrapper against Tableland's REST API
  const rpc = Array.isArray(rpcUrl) ? rpcUrl[0] : rpcUrl;
  const fnEnv: Record<string, unknown> = { params, rpc: rpcUrl };

  if (workerEnv?.HYBERDB_ADDRESS) {
    try {
      const { HyberDBClient } = await import('@hybertext/db');
      fnEnv.db = new HyberDBClient({ rpcUrl: rpc, contractAddress: workerEnv.HYBERDB_ADDRESS });
    } catch { /* db package not available — skip */ }
  }

  if (workerEnv?.EDGE_KV) {
    fnEnv.kv = workerEnv.EDGE_KV;
  }

  fnEnv.tableland = {
    async query(sql: string): Promise<unknown> {
      const res = await fetch(
        `https://tableland.network/api/v1/query?statement=${encodeURIComponent(sql)}`,
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) throw new Error(`Tableland query failed: HTTP ${res.status}`);
      return res.json();
    },
  };

  return fn(request, fnEnv) as Promise<Response>;
}

// ---------------------------------------------------------------------------
// Encrypted site handling
// ---------------------------------------------------------------------------

/**
 * Handle an ENCRYPTED HYTE site request.
 * Checks for valid session cookie or payment headers; returns 402 if neither present.
 * On valid payment: records grant on-chain, issues session, then decrypts and serves.
 */
async function serveEncrypted(
  txHash:    string,
  assetPath: string,
  decoded:   ResolveSiteResult,
  request:   Request,
  env:       Env,
  ctx:       ExecutionContext,
): Promise<Response> {
  const rpcUrl       = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const rpcUrls      = [rpcUrl, ...(env.RPC_FALLBACKS ?? '').split(',').map(s => s.trim()).filter(Boolean)];
  const vaultAddress = (decoded.vault ?? env.VAULT_ADDRESS) as string | undefined;
  const privKey      = env.VAULT_X25519_PRIVKEY;

  if (!vaultAddress || !privKey) {
    return new Response('Encrypted site: vault not configured on this gateway', { status: 503 });
  }

  // ── Fetch vault record (needed for 402 and for payment verification) ─────
  const vault = await fetchVaultRecord(txHash, vaultAddress, rpcUrl);
  if (!vault) {
    return new Response('Vault record not found for this site', { status: 404 });
  }
  if (!vault.active) {
    return new Response('This site\'s vault is inactive — access currently unavailable', { status: 403 });
  }

  const sessionsKV = env.PAYMENT_SESSIONS_KV;
  const usedKV     = env.PAYMENT_USED_KV;

  // ── Check session cookie ─────────────────────────────────────────────────
  if (sessionsKV) {
    const sessionToken = parseSessionCookie(request.headers.get('Cookie'));
    if (sessionToken) {
      const sess = await checkSession(sessionToken, txHash, sessionsKV);
      if (sess.valid) {
        return decryptAndServe(txHash, assetPath, decoded, privKey, vault, request, ctx, rpcUrls);
      }
    }
  }

  // ── Check payment headers ────────────────────────────────────────────────
  const paymentTxHash  = request.headers.get('X-Payment-Tx');
  const payerAddress   = request.headers.get('X-Payment-Payer');

  if (paymentTxHash && payerAddress) {
    const result = await verifyPayment(
      txHash, paymentTxHash, payerAddress, vault, rpcUrl,
      usedKV, vaultAddress,
    );

    if (!result.valid) {
      return new Response(
        JSON.stringify({ error: 'Payment verification failed', reason: result.error }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Record grant on-chain (fire-and-forget — non-blocking)
    ctx.waitUntil(recordGrantOnChain(txHash, payerAddress, paymentTxHash, vault, vaultAddress, env));

    // Issue session
    let sessionToken = '';
    let cookieMaxAge = 86400;
    if (sessionsKV && usedKV) {
      const sess = await issueSession(txHash, payerAddress, vault, sessionsKV, usedKV, paymentTxHash);
      sessionToken = sess.token;
      cookieMaxAge = sess.cookieMaxAge;
    }

    const contentResponse = await decryptAndServe(txHash, assetPath, decoded, privKey, vault, request, ctx, rpcUrls);

    // Attach session cookie to the response
    if (sessionToken) {
      const response = new Response(contentResponse.body, contentResponse);
      response.headers.set(
        'Set-Cookie',
        `hyber_session=${sessionToken}; Path=/${txHash}; HttpOnly; Secure; SameSite=None; Max-Age=${cookieMaxAge}`,
      );
      return response;
    }
    return contentResponse;
  }

  // ── No session, no payment → 402 ────────────────────────────────────────
  return make402Response(txHash, vault, new URL(request.url).origin);
}

/** Unwrap CEK and decrypt the payload, then serve like a normal site. */
async function decryptAndServe(
  txHash:    string,
  assetPath: string,
  decoded:   ResolveSiteResult,
  privKey:   string,
  vault:     import('./vault.js').VaultRecord,
  request:   Request,
  ctx:       ExecutionContext,
  rpcUrl:    string | string[],
): Promise<Response> {
  // Unwrap Content Encryption Key
  const cek = await unwrapCEK(vault.wrappedKey, privKey);

  // Decrypt payload → compressed inner HYTE payload (not decompressed yet)
  const decryptedCompressed = await vaultDecrypt(decoded.payload, cek);

  // Decompress
  const plaintext = Buffer.from(await decompress(Buffer.from(decryptedCompressed), decoded.compression));

  // Build a synthetic ResolveSiteResult as if this were a cleartext TAR site
  // The inner payload is a compressed TAR (or HTML), now decompressed
  const innerDecoded: ResolveSiteResult = {
    contentType: decoded.contentType === ContentType.ENCRYPTED ? ContentType.TAR : decoded.contentType,
    compression: decoded.compression,
    payload:     plaintext,
  };

  return serveGateway(txHash, assetPath, rpcUrl, request, ctx, innerDecoded);
}

// Selector: cast sig "grantAccess(bytes32,address,bytes32)" = 0x7b9e099d
const GRANT_ACCESS_SELECTOR = '7b9e099d';

async function recordGrantOnChain(
  siteTxHash:    string,
  payer:         string,
  paymentTxHash: string,
  vault:         import('./vault.js').VaultRecord,
  vaultAddress:  string,
  env:           Env,
): Promise<void> {
  if (!env.PRIVATE_KEY || !env.BERACHAIN_RPC) return;
  try {
    // ABI-encode grantAccess(bytes32, address, bytes32)
    const site    = (siteTxHash.startsWith('0x') ? siteTxHash.slice(2) : siteTxHash).padStart(64, '0');
    const addr    = payer.slice(2).padStart(64, '0');
    const payment = (paymentTxHash.startsWith('0x') ? paymentTxHash.slice(2) : paymentTxHash).padStart(64, '0');
    const data    = '0x' + GRANT_ACCESS_SELECTOR + site + addr + payment;

    const rpcUrl = env.BERACHAIN_RPC;

    // Get nonce
    const nonceHex = await rpcFetch(rpcUrl, 'eth_getTransactionCount', [
      `0x${await getFromAddress(env.PRIVATE_KEY)}`, 'pending',
    ]) as string;

    const gasPriceHex = await rpcFetch(rpcUrl, 'eth_gasPrice', []) as string;

    // Build + send tx via fetch (avoid viem to keep Worker bundle small)
    // We use the existing pattern from upload.ts
    const { createWalletClient, http, defineChain } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const chain = defineChain({
      id: 80094,
      name: 'Berachain',
      nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const account = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
    const wallet  = createWalletClient({ account, chain, transport: http(rpcUrl) });
    await wallet.sendTransaction({
      to:       vaultAddress as `0x${string}`,
      data:     data as `0x${string}`,
      value:    0n,
      gas:      80_000n,
      gasPrice: BigInt(gasPriceHex),
      nonce:    parseInt(nonceHex, 16),
    });
  } catch {
    // Non-fatal: KV-based replay prevention already handles most cases
  }
}

async function rpcFetch(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function getFromAddress(privateKey: string): Promise<string> {
  const { privateKeyToAccount } = await import('viem/accounts');
  return privateKeyToAccount(privateKey as `0x${string}`).address.slice(2);
}

// ---------------------------------------------------------------------------
// Alias resolver factory
// ---------------------------------------------------------------------------

function makeResolver(env: Env): CompositeResolver {
  const rpcUrl       = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const registryAddr = (env.REGISTRY_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`;
  return new CompositeResolver([
    new HyberRegistryResolver(rpcUrl, registryAddr),
    new ENSResolver(rpcUrl),
    new BeranamesResolver(rpcUrl),
  ]);
}

// ---------------------------------------------------------------------------
// Gateway helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// V4 manifest serving
// ---------------------------------------------------------------------------

/** Fetch a BLOB-type HYTE tx, strip the 9-byte header, and decompress. */
async function fetchBlobEntry(entry: V4FileEntry, rpcUrl: string | string[]): Promise<Buffer> {
  const raw         = await fetchTxInput(entry.tx as `0x${string}`, rpcUrl);
  const compression = raw[5]; // compression byte from HYTE header
  return Buffer.from(await decompress(raw.subarray(9), compression));
}

/**
 * Serve a file from a manifest v4 site.
 * Applies _redirects and _headers from the manifest's own file entries.
 */
async function serveV4Gateway(
  txHash:    string,
  assetPath: string,
  rpcUrl:    string | string[],
  request:   Request,
  ctx:       ExecutionContext,
  manifest:  ManifestV4,
): Promise<Response> {
  const key = assetPath.replace(/^\//, '') || 'index.html';

  // ── Apply _redirects if present in the manifest ────────────────────────────
  if (manifest.files['_redirects']) {
    const buf = await fetchBlobEntry(manifest.files['_redirects'], rpcUrl);
    const redirects = parseRedirects(buf.toString('utf8'));
    const result = applyRewrites('/' + key, redirects, []);
    if (result.redirect) {
      return Response.redirect(result.redirect.location, result.redirect.status);
    }
  }

  // ── Resolve file (directory index / SPA fallback) ─────────────────────────
  let fileEntry: V4FileEntry | undefined =
    manifest.files[key] ?? manifest.files[key.replace(/\/$/, '') + '/index.html'];

  if (!fileEntry && !(key.includes('.') && !key.endsWith('/'))) {
    fileEntry = manifest.files['404.html'] ?? manifest.files['index.html'];
  }
  if (!fileEntry) return new Response('Not found', { status: 404 });

  // ── Cache lookup ───────────────────────────────────────────────────────────
  const cache  = (caches as any).default as Cache;
  const cached = await cache.match(request);
  if (cached) return cached;

  // ── Fetch content ──────────────────────────────────────────────────────────
  const content = await fetchBlobEntry(fileEntry, rpcUrl);

  // ── Collect custom headers from _headers ──────────────────────────────────
  const extraHeaders: Record<string, string> = {};
  if (manifest.files['_headers']) {
    const buf  = await fetchBlobEntry(manifest.files['_headers'], rpcUrl);
    const rules = parseHeaders(buf.toString('utf8'));
    const result = applyRewrites('/' + key, [], rules);
    if (result.headers) Object.assign(extraHeaders, result.headers);
  }

  const ct   = fileEntry.mime || mimeType(key);
  const base = `/${txHash}`;

  // ── Path rewriting (same as serveGateway) ─────────────────────────────────
  let body: BodyInit = content;
  if (ct.startsWith('text/html')) {
    let html = content.toString('utf8')
      .replace(/((?:href|src|action|data-src|data-href|content|poster)=["'])\//g, `$1${base}/`)
      .replace(/url\(\//g, `url(${base}/`)
      .replace(/@import\s+["']\//g, `@import "${base}/`);
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${base}/">`);
    }
    body = html;
  } else if (ct === 'text/css') {
    body = content.toString('utf8')
      .replace(/url\(\//g, `url(${base}/`)
      .replace(/@import\s+["']\//g, `@import "${base}/`);
  }

  const response = new Response(body, {
    headers: {
      'Content-Type':         ct,
      'Cache-Control':        'public, max-age=31536000, immutable',
      'X-HyberText-TxHash':   txHash,
      ...extraHeaders,
    },
  });

  ctx.waitUntil(cache.put(request, response.clone()));
  return response;
}

/**
 * Serve a site via its txHash with full path rewriting and <base> tag injection.
 * Used for the /{txHash}/path route.
 * Accepts an optional pre-decoded result to avoid double-fetching when the caller
 * has already resolved the site (e.g. to check for function routes).
 */
async function serveGateway(
  txHash: string,
  assetPath: string,
  rpcUrl: string | string[],
  request: Request,
  ctx: ExecutionContext,
  preDecoded?: ResolveSiteResult,
  workerEnv?: Env,
): Promise<Response> {
  // ── Check specific function routes (skip _worker — it's a catch-all) ──────
  if (preDecoded?.functions) {
    const normalised = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    for (const [pattern, fnTxHash] of Object.entries(preDecoded.functions)) {
      if (pattern === '_worker') continue;
      const params = matchFunctionRoute(pattern, normalised);
      if (params !== null) {
        const fnUrl = preDecoded.fnUrls?.[pattern];
        if (fnUrl) return proxyToFunctionUrl(fnUrl, request, workerEnv as Record<string, unknown>);
        const fnHash = preDecoded.fnHashes?.[pattern];
        return callFunction(fnTxHash, params, request, rpcUrl, fnHash, workerEnv);
      }
    }
  }

  // ── Cache lookup ────────────────────────────────────────────────────────────
  // Content is immutable (txHash-addressed), so any cached response is valid forever.
  // Skip cache when a _worker catch-all is present — stale entries may shadow
  // dynamic routes that the function worker should handle.
  const hasWorker = !!(preDecoded?.functions?.['_worker'] && preDecoded.fnUrls?.['_worker']);
  const cache = (caches as any).default as Cache;
  const cached = hasWorker ? null : await cache.match(request);
  if (cached) return cached;

  // ── Resolve site (use pre-decoded result if available) ───────────────────
  const decoded = preDecoded ?? await resolveSite(txHash as `0x${string}`, rpcUrl);

  let files: Map<string, Buffer>;
  try {
    files = decoded.contentType === ContentType.HTML
      ? new Map([['index.html', decoded.payload]])
      : await extractTar(decoded.payload);
  } catch (tarErr: any) {
    return new Response('extractTar failed: ' + tarErr.message, { status: 500 });
  }

  const key = assetPath.replace(/^\//, '') || 'index.html';

  // Direct match or directory index
  let buf = files.get(key) ?? files.get(`${key.replace(/\/$/, '')}/index.html`);

  if (!buf) {
    // _worker catch-all takes priority over SPA fallback so API routes reach the worker.
    // When _worker is present it is responsible for both dynamic routes AND SPA fallback.
    if (decoded.functions?.['_worker']) {
      const fnUrl  = decoded.fnUrls?.['_worker'];
      if (fnUrl) return proxyToFunctionUrl(fnUrl, request, workerEnv as Record<string, unknown>);
      const fnHash = decoded.fnHashes?.['_worker'];
      return callFunction(decoded.functions['_worker'], {}, request, rpcUrl, fnHash, workerEnv);
    }
    // No _worker: SPA fallback for extensionless paths (single-page apps)
    const hasExt = key.includes('.') && !key.endsWith('/');
    if (!hasExt) {
      buf = files.get('404.html') ?? files.get('index.html');
    }
    if (!buf) return new Response('Not found', { status: 404 });
  }

  const ct = mimeType(key);
  const base = `/${txHash}`;

  // Rewrite absolute paths in HTML and CSS so relative assets resolve correctly
  // under the /{txHash}/ path prefix. Replaces href="/ src="/ url(/ etc.
  let body: BodyInit = buf;
  if (ct.startsWith('text/html')) {
    let html = buf.toString('utf8')
      .replace(/((?:href|src|action|data-src|data-href|content|poster)=["'])\//g, `$1${base}/`)
      .replace(/url\(\//g, `url(${base}/`)
      .replace(/@import\s+["']\//g, `@import "${base}/`);
    // Inject <base> tag so JS-constructed relative URLs also resolve correctly
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${base}/">`);
    }
    body = html;
  } else if (ct === 'text/css') {
    body = buf.toString('utf8')
      .replace(/url\(\//g, `url(${base}/`)
      .replace(/@import\s+["']\//g, `@import "${base}/`);
  }

  const response = new Response(body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-HyberText-TxHash': txHash,
    },
  });

  // Store in cache — use waitUntil so the response isn't delayed
  ctx.waitUntil(cache.put(request, response.clone()));

  return response;
}

/**
 * Serve a site at the root domain (subdomain alias mode).
 * No path rewriting or <base> tag injection — the site is at /.
 * Cache key includes txHash prefix to avoid collisions with gateway mode.
 */
async function serveRoot(
  txHash: string,
  assetPath: string,
  rpcUrl: string | string[],
  request: Request,
  ctx: ExecutionContext,
  workerEnv?: Env,
): Promise<Response> {
  // ── Resolve site (get functions from manifest if v2) ─────────────────────
  const decoded = await resolveSite(txHash as `0x${string}`, rpcUrl);

  // ── Check specific function routes (skip _worker — it's a catch-all) ──────
  if (decoded.functions) {
    const normalised = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
    for (const [pattern, fnTxHash] of Object.entries(decoded.functions)) {
      if (pattern === '_worker') continue;
      const params = matchFunctionRoute(pattern, normalised);
      if (params !== null) {
        const fnUrl = decoded.fnUrls?.[pattern];
        if (fnUrl) return proxyToFunctionUrl(fnUrl, request, workerEnv as Record<string, unknown>);
        const fnHash = decoded.fnHashes?.[pattern];
        return callFunction(fnTxHash, params, request, rpcUrl, fnHash, workerEnv);
      }
    }
  }

  // ── Cache lookup (keyed by txHash + path, not raw URL, to avoid collisions) ─
  const cache    = (caches as any).default as Cache;
  const cacheKey = new Request(`https://root.hybertext.internal/${txHash}${assetPath}`);
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const files: Map<string, Buffer> =
    decoded.contentType === ContentType.HTML
      ? new Map([['index.html', decoded.payload]])
      : await extractTar(decoded.payload);

  const key = assetPath.replace(/^\//, '') || 'index.html';

  let buf = files.get(key) ?? files.get(`${key.replace(/\/$/, '')}/index.html`);

  if (!buf) {
    // _worker catch-all takes priority over SPA fallback so API routes reach the worker.
    if (decoded.functions?.['_worker']) {
      const fnUrl  = decoded.fnUrls?.['_worker'];
      if (fnUrl) return proxyToFunctionUrl(fnUrl, request, workerEnv as Record<string, unknown>);
      const fnHash = decoded.fnHashes?.['_worker'];
      return callFunction(decoded.functions['_worker'], {}, request, rpcUrl, fnHash, workerEnv);
    }
    // No _worker: SPA fallback for extensionless paths (single-page apps)
    const hasExt = key.includes('.') && !key.endsWith('/');
    if (!hasExt) {
      buf = files.get('404.html') ?? files.get('index.html');
    }
    if (!buf) return new Response('Not found', { status: 404 });
  }

  const ct = mimeType(key);

  // No path rewriting in root mode — the site's own absolute paths are correct
  const body: BodyInit = buf;

  const response = new Response(body, {
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-HyberText-TxHash': txHash,
    },
  });

  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  // ── Scheduled cron handler ─────────────────────────────────────────────────
  // Fires on the schedule defined in wrangler.toml [triggers].
  // Publishes a fresh index snapshot to the chain so the index is discoverable
  // without scanning all eth_getLogs history.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const rpc = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

    // Publish a fresh HyberIndex snapshot so the index is discoverable on-chain.
    const indexAddress = env.HYBERINDEX_ADDRESS;
    if (env.PRIVATE_KEY && indexAddress && indexAddress !== '0x0000000000000000000000000000000000000000') {
      ctx.waitUntil((async () => {
        try {
          const { queryIndex, maybePublishSnapshot } = await import('./index-query.js');
          const entries = await queryIndex(indexAddress, rpc, { limit: 200 });
          await maybePublishSnapshot(entries, indexAddress, rpc, env.PRIVATE_KEY!, /* force= */ true);
        } catch { /* non-fatal */ }
      })());
    }

    // Refresh the DB state cache for every namespace currently stored in KV.
    // Only re-fetches namespaces whose on-chain head has changed since last cache.
    if (env.EDGE_KV && env.HYBERDB_ADDRESS) {
      ctx.waitUntil(
        warmDbCache(env.EDGE_KV as any, rpc, env.HYBERDB_ADDRESS),
      );
    }

    // Warm research feeds: scan HyberIndex for contentType=9 (Insights) and
    // contentType=10 (Strategies) published since the last cron run, and
    // populate per-topic KV feeds + reverse citation index.
    if (env.EDGE_KV && env.HYBERINDEX_ADDRESS &&
        env.HYBERINDEX_ADDRESS !== '0x0000000000000000000000000000000000000000') {
      ctx.waitUntil((async () => {
        try {
          const { queryIndex }      = await import('./index-query.js');
          const { kvUpdateFeeds, kvUpdateCitedBy, kvGetInsightSummary,
                  CONTENT_TYPE_INSIGHT } = await import('./research.js');
          const kv          = env.EDGE_KV as any;
          const fromBlock   = env.HYBERINDEX_FROM_BLOCK ?? '0x0';
          const allEntries  = await queryIndex(env.HYBERINDEX_ADDRESS!, rpc, {
            fromBlock, limit: 200,
          });
          const insights = allEntries.filter(e => e.contentType === CONTENT_TYPE_INSIGHT);

          for (const entry of insights) {
            // Skip if already cached
            const cached = await kvGetInsightSummary(kv, entry.txHash);
            if (cached) continue;

            // Fetch the Insight JSON from the gateway HTTP endpoint
            const gatewayBase = env.BASE_DOMAIN
              ? `https://${env.BASE_DOMAIN}`
              : 'https://hybertext-mcp.carnation-903.workers.dev';
            const res = await fetch(`${gatewayBase}/${entry.txHash}/insight.json`);
            if (!res.ok) continue;
            let insight: any;
            try { insight = await res.json(); } catch { continue; }
            if (insight?.v !== 1 || !insight.topics) continue;

            await kvUpdateFeeds(kv, insight);
            if (insight.citations?.length) {
              await kvUpdateCitedBy(kv, insight.citations, entry.txHash);
            }
          }
        } catch { /* non-fatal */ }
      })());
    }
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url      = new URL(request.url);
    const rpcUrl   = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
    const rpcUrls  = [rpcUrl, ...(env.RPC_FALLBACKS ?? '').split(',').map(s => s.trim()).filter(Boolean)];

    // ── MCP server ───────────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      const server    = createServer(rpcUrl, env);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    // ── Vault public key endpoint ────────────────────────────────────────────
    // Publishers call GET /vault/pubkey to get the Worker's X25519 public key
    // so they can wrap their site's Content Encryption Key for this gateway.
    if (url.pathname === '/vault/pubkey') {
      if (!env.VAULT_X25519_PUBKEY && !env.VAULT_X25519_PRIVKEY) {
        return new Response(JSON.stringify({ error: 'Vault not configured' }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      }
      const pubkey = env.VAULT_X25519_PUBKEY
        ?? (env.VAULT_X25519_PRIVKEY ? getVaultPublicKey(env.VAULT_X25519_PRIVKEY) : '');
      return new Response(JSON.stringify({ pubkey, hint: 'Use with: hybertext deploy --encrypt --vault-pubkey ' + pubkey }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // ── Index endpoints ──────────────────────────────────────────────────────
    // GET /index                        — recent publishes (all)
    // GET /index?publisher=0x...        — by publisher
    // GET /index?limit=N&from=blockHex  — pagination
    // GET /index/publisher/:address     — same as ?publisher=
    if (request.method === 'GET' && (url.pathname === '/index' || url.pathname.startsWith('/index/'))) {
      const corsJson = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

      const indexAddress = env.HYBERINDEX_ADDRESS;
      if (!indexAddress || indexAddress === '0x0000000000000000000000000000000000000000') {
        return new Response(JSON.stringify({ error: 'HyberIndex not configured on this gateway' }), { status: 503, headers: corsJson });
      }

      // Route: /index/publisher/:address
      const pubMatch = url.pathname.match(/^\/index\/publisher\/(0x[a-fA-F0-9]{40})$/);
      const publisher = pubMatch?.[1] ?? url.searchParams.get('publisher') ?? undefined;

      const limit     = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
      const fromBlock = url.searchParams.get('from') ?? '0x0';

      try {
        const { queryIndex, maybePublishSnapshot } = await import('./index-query.js');
        const hyberIndexFromBlock = env.HYBERINDEX_FROM_BLOCK ?? fromBlock;
        const entries = await queryIndex(indexAddress, rpcUrl, { publisher, limit, fromBlock: hyberIndexFromBlock });

        // Background: periodically publish a snapshot blob so the index is
        // discoverable on-chain without scanning all events.
        if (env.PRIVATE_KEY) {
          ctx.waitUntil(maybePublishSnapshot(entries, indexAddress, rpcUrl, env.PRIVATE_KEY));
        }

        return new Response(JSON.stringify({ entries, total: entries.length }), { headers: corsJson });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsJson });
      }
    }

    // ── Research API ─────────────────────────────────────────────────────────
    // GET /research/api?topic=gpt-training&limit=50
    // Returns machine-readable JSON for the live monitoring dashboard.
    if (url.pathname === '/research/api') {
      const corsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      };
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: corsHeaders });
      }

      const topic = url.searchParams.get('topic') ?? 'gpt-training';
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 50);

      if (!env.EDGE_KV) {
        return new Response(JSON.stringify({ error: 'KV not configured' }), { status: 503, headers: corsHeaders });
      }

      const kv = env.EDGE_KV as any;
      const { kvGetFeed, kvGetClaims, getLeaderboard } = await import('./research.js');

      const [feed, claims, leaderboard] = await Promise.all([
        kvGetFeed(kv, topic, limit),
        kvGetClaims(kv, topic),
        getLeaderboard(kv, topic, 20),
      ]);

      return new Response(JSON.stringify({ topic, feed, claims, leaderboard, fetchedAt: Date.now() }), {
        headers: corsHeaders,
      });
    }

    // ── Linear UI ────────────────────────────────────────────────────────────
    if (url.pathname === '/linear') {
      return new Response(linearPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── Taskboard REST API ───────────────────────────────────────────────────
    if (url.pathname.startsWith('/api/taskboard/')) {
      const apiResponse = await handleTaskboardApi(request, url, env);
      if (apiResponse) return apiResponse;
    }

    // ── Publish endpoint ─────────────────────────────────────────────────────
    if (url.pathname === '/publish' && request.method === 'POST') {
      try {
        return await handlePublish(request, env, url.origin);
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message ?? 'Internal error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // ── DB gateway ───────────────────────────────────────────────────────────
    if (url.pathname.startsWith('/db/') || url.pathname === '/db/_relay') {
      try {
        const dbResponse = await handleDbRequest(request, url, { ...env, kv: env.EDGE_KV as any });
        if (dbResponse) return dbResponse;
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message ?? 'DB error' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    // ── Subdomain alias resolution ─────────────────────────────────────────
    // If the request host is {name}.{BASE_DOMAIN}, resolve the alias and serve
    // the site at the root (no txHash prefix in URL).
    const host       = request.headers.get('Host') ?? '';
    const baseDomain = env.BASE_DOMAIN;
    const subdomain  =
      baseDomain && host !== baseDomain && host.endsWith('.' + baseDomain)
        ? host.slice(0, -(baseDomain.length + 1))
        : null;

    if (subdomain) {
      try {
        const resolver  = makeResolver(env);
        const resolved  = await resolver.resolve(subdomain);
        if (resolved) {
          return await serveRoot(resolved, url.pathname, rpcUrls, request, ctx, env);
        }
        return new Response('Name not found', { status: 404 });
      } catch (e: any) {
        return new Response(`Failed to resolve name: ${e.message}`, { status: 500 });
      }
    }

    // ── HTTP gateway  GET /0x{txhash}[/asset/path] ───────────────────────────
    const parts     = url.pathname.split('/').filter(Boolean);
    const txHash    = parts[0] ?? '';
    const assetPath = '/' + parts.slice(1).join('/');

    if (TX_HASH_RE.test(txHash)) {
      try {
        // Resolve site first to get the functions map (needed before cache check
        // so function routes can bypass the cache). Pass decoded result through
        // so serveGateway doesn't fetch a second time.
        const decoded = await resolveSite(txHash as `0x${string}`, rpcUrls);

        // v4 manifest — per-file serving
        if (decoded.v4manifest) {
          return await serveV4Gateway(txHash, assetPath, rpcUrls, request, ctx, decoded.v4manifest);
        }

        // Encrypted sites: gate on payment before serving
        if (decoded.contentType === ContentType.ENCRYPTED) {
          return await serveEncrypted(txHash, assetPath, decoded, request, env, ctx);
        }

        return await serveGateway(txHash, assetPath, rpcUrls, request, ctx, decoded, env);
      } catch (err: any) {
        return new Response(`Failed to resolve site: ${err.message}`, { status: 500 });
      }
    }

    // ── Name-based routing: /{name}/path ─────────────────────────────────────
    // If the first path segment looks like a name (not a tx hash, not a dotfile),
    // try resolving it as an alias and redirect to the canonical /{txHash}/ URL.
    if (txHash && !/^[_.]/.test(txHash)) {
      try {
        const resolver     = makeResolver(env);
        const resolvedHash = await resolver.resolve(txHash);
        if (resolvedHash) {
          return Response.redirect(`${url.origin}/${resolvedHash}${assetPath}`, 301);
        }
      } catch {
        // If alias resolution fails, fall through to the landing page
      }
    }

    // ── Landing page ─────────────────────────────────────────────────────────
    return new Response(landingPage(url.host), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
