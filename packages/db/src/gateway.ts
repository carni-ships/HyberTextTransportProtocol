import { HyberDBClient } from './client';
import { handleRelay } from './relayer';
import type { JsonValue, DbOp, QueryOptions, RelayRequest, RelayEnv } from './types';

// ---------------------------------------------------------------------------
// KV cache interface (compatible with Cloudflare KV, no @cloudflare/workers-types dep)
// ---------------------------------------------------------------------------

export interface KvCache {
  get(key: string, type: 'json'): Promise<unknown | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  list?(opts: { prefix: string }): Promise<{ keys: Array<{ name: string }> }>;
}

export interface DbGatewayEnv {
  BERACHAIN_RPC?:   string;
  HYBERDB_ADDRESS?: string;
  PRIVATE_KEY?:     string;
  /** Cloudflare KV namespace for caching namespace state. Pass EDGE_KV binding. */
  kv?:              KvCache;
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

// After this many writes since the last snapshot, trigger an auto-snapshot.
const SNAPSHOT_THRESHOLD = 50;

const kvStateKey      = (ns: string) => `db:state:${ns}`;
const kvWriteCountKey = (ns: string) => `db:writes:${ns}`;

interface CachedNsState {
  head: string;
  data: Record<string, JsonValue>;
}

async function getCached(kv: KvCache, ns: string): Promise<CachedNsState | null> {
  try { return await kv.get(kvStateKey(ns), 'json') as CachedNsState | null; }
  catch { return null; }
}

async function setCached(kv: KvCache, ns: string, head: string, data: Record<string, JsonValue>): Promise<void> {
  try { await kv.put(kvStateKey(ns), JSON.stringify({ head, data })); }
  catch { /* non-fatal */ }
}

/**
 * Fetch all records at `head` from chain, cache in KV, return raw data map.
 * Uses `at: head` so the client skips the info() RPC call.
 */
async function fetchAndCache(
  client: HyberDBClient,
  ns: string,
  head: string,
  kv: KvCache,
): Promise<Record<string, JsonValue>> {
  const result = await client.getAll(ns, { at: head });
  const data: Record<string, JsonValue> = {};
  for (const { key: k, val } of result.records) data[k] = val;
  await setCached(kv, ns, head, data);
  return data;
}

/**
 * After a write, update the KV cache and increment the write counter.
 * If the counter exceeds SNAPSHOT_THRESHOLD, resets the counter and returns
 * true to signal that the caller should trigger a background snapshot.
 */
async function afterWrite(
  client: HyberDBClient,
  ns: string,
  newHead: string,
  kv: KvCache,
): Promise<boolean> {
  try {
    await fetchAndCache(client, ns, newHead, kv);
    const prev  = await kv.get(kvWriteCountKey(ns), 'json') as number | null;
    const count = (prev ?? 0) + 1;
    if (count >= SNAPSHOT_THRESHOLD) {
      await kv.put(kvWriteCountKey(ns), '0');
      return true; // caller should snapshot
    }
    await kv.put(kvWriteCountKey(ns), JSON.stringify(count));
  } catch { /* non-fatal */ }
  return false;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

// DB requests start with /db/
const DB_PREFIX = '/db/';

function dbErr(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function dbOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// applyQueryOpts — filter/sort/paginate a raw data map in memory
// ---------------------------------------------------------------------------

function applyQueryOpts(
  data: Record<string, JsonValue>,
  opts: QueryOptions,
): { records: Array<{ key: string; val: JsonValue }>; total: number } {
  let records = Object.entries(data).map(([key, val]) => ({ key, val }));

  if (opts.where) {
    const where = opts.where;
    records = records.filter(({ val }) => {
      if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
      return Object.entries(where).every(([k, v]) => (val as Record<string, JsonValue>)[k] === v);
    });
  }

  if (opts.orderBy) {
    const field = opts.orderBy;
    const dir   = opts.orderDir === 'desc' ? -1 : 1;
    records.sort((a, b) => {
      const av = typeof a.val === 'object' && a.val !== null ? (a.val as Record<string, JsonValue>)[field] : a.val;
      const bv = typeof b.val === 'object' && b.val !== null ? (b.val as Record<string, JsonValue>)[field] : b.val;
      if (av == null && bv == null) return 0;
      if (av == null) return dir;
      if (bv == null) return -dir;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
  }

  const total   = records.length;
  const offset  = opts.offset ?? 0;
  const limited = opts.limit ? records.slice(offset, offset + opts.limit) : records.slice(offset);
  return { records: limited, total };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle a DB gateway request.
 * Returns a Response for DB paths, or null to fall through to the next handler.
 *
 * URL convention:
 *   /db/_relay               — gasless write relay (POST)
 *   /db/{owner}/{collection} — collection query (GET) or batch write (POST _batch)
 *   /db/{owner}/{collection}/_info     — namespace metadata
 *   /db/{owner}/{collection}/_batch    — batch ops (POST)
 *   /db/{owner}/{collection}/_snapshot — take a snapshot (POST)
 *   /db/{owner}/{collection}/{key}     — single record CRUD
 *
 * When env.kv is set, reads are served from a KV state cache keyed by
 * namespace head. A single eth_call (getNamespace) validates freshness;
 * on hit, no chain traversal occurs. Writes update the cache immediately.
 */
export async function handleDbRequest(
  request: Request,
  url: URL,
  env: DbGatewayEnv,
): Promise<Response | null> {
  if (!url.pathname.startsWith(DB_PREFIX) && url.pathname !== '/db/_relay') return null;

  const rpcUrl = env.BERACHAIN_RPC   ?? 'https://rpc.berachain.com';
  const dbAddr = env.HYBERDB_ADDRESS as `0x${string}` | undefined;

  if (!dbAddr || dbAddr === '0x0000000000000000000000000000000000000000') {
    return dbErr(503, 'HyberDB not configured — set HYBERDB_ADDRESS');
  }

  // ── Relay endpoint: POST /db/_relay ──────────────────────────────────────
  if (url.pathname === '/db/_relay' && request.method === 'POST') {
    if (!env.PRIVATE_KEY) return dbErr(503, 'Relay not configured — set PRIVATE_KEY');
    try {
      const req    = await request.json() as RelayRequest;
      const result = await handleRelay(req, {
        rpcUrl,
        contractAddress: dbAddr,
        privateKey:      env.PRIVATE_KEY as `0x${string}`,
      });
      return dbOk(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Relay failed';
      return dbErr(400, msg);
    }
  }

  // Everything else needs a db address and client
  const client = new HyberDBClient({ rpcUrl, contractAddress: dbAddr });

  // Parse path after /db/
  // Convention: namespace is always exactly 2 segments (owner/collection).
  // Key is everything after that.
  const rest  = url.pathname.slice(DB_PREFIX.length);   // e.g. "my-app/users/alice"
  const parts = rest.split('/').filter(Boolean);

  if (parts.length < 2) {
    return dbErr(400, 'Path must be at least /db/{owner}/{collection}');
  }

  const ns  = parts.slice(0, 2).join('/');              // "my-app/users"
  const key = parts.slice(2).join('/') || undefined;    // "alice" or undefined

  // ── Special sub-paths ─────────────────────────────────────────────────────

  if (key === '_info') {
    try {
      const info = await client.info(ns);
      if (!info) return dbErr(404, `Namespace "${ns}" not found`);
      return dbOk(info);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Internal error';
      return dbErr(500, msg);
    }
  }

  if (key === '_batch' && request.method === 'POST') {
    try {
      const body = await request.json() as { ops: DbOp[] };
      if (!Array.isArray(body.ops)) return dbErr(400, 'ops must be an array');
      const txHash    = await client.batch(ns, body.ops);
      const doSnap    = env.kv ? await afterWrite(client, ns, txHash, env.kv) : false;
      if (doSnap)       client.snapshot(ns).catch(() => { /* non-fatal */ });
      return dbOk({ txHash });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Batch failed';
      return dbErr(400, msg);
    }
  }

  if (key === '_snapshot' && request.method === 'POST') {
    try {
      const txHash = await client.snapshot(ns);
      // After snapshot, cache the new state and reset write counter
      if (env.kv) {
        fetchAndCache(client, ns, txHash, env.kv).catch(() => { /* non-fatal */ });
        env.kv.put(kvWriteCountKey(ns), '0').catch(() => { /* non-fatal */ });
      }
      return dbOk({ txHash });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Snapshot failed';
      return dbErr(400, msg);
    }
  }

  // ── Collection endpoints ─────────────────────────────────────────────────

  const at = url.searchParams.get('at') ?? undefined;

  if (!key) {
    // GET /db/:ns — query collection
    if (request.method !== 'GET') return dbErr(405, 'Method not allowed');
    try {
      const whereParam = url.searchParams.get('where');
      const opts: QueryOptions = {
        where:    whereParam   ? JSON.parse(whereParam) as Record<string, JsonValue> : undefined,
        orderBy:  url.searchParams.get('orderBy')  ?? undefined,
        orderDir: (url.searchParams.get('orderDir') as 'asc' | 'desc' | undefined) ?? undefined,
        limit:    url.searchParams.get('limit')    ? parseInt(url.searchParams.get('limit')!, 10)  : undefined,
        offset:   url.searchParams.get('offset')   ? parseInt(url.searchParams.get('offset')!, 10) : undefined,
        at,
      };

      // KV cache path: one eth_call to validate head, then serve from KV on hit.
      // Skip cache for historical queries (?at=...).
      if (env.kv && !at) {
        const [nsInfo, cached] = await Promise.all([
          client.info(ns),
          getCached(env.kv, ns),
        ]);
        if (!nsInfo) return dbErr(404, `Namespace "${ns}" not found`);

        const onChainHead = nsInfo.head;
        const data = (cached?.head === onChainHead)
          ? cached.data
          : await fetchAndCache(client, ns, onChainHead, env.kv);

        return dbOk(applyQueryOpts(data, opts));
      }

      const result = await client.getAll(ns, opts);
      return dbOk(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Query failed';
      return dbErr(500, msg);
    }
  }

  // ── Record endpoints ─────────────────────────────────────────────────────

  if (request.method === 'GET') {
    try {
      // KV cache path: same head check, then key lookup in memory.
      if (env.kv && !at) {
        const [nsInfo, cached] = await Promise.all([
          client.info(ns),
          getCached(env.kv, ns),
        ]);
        if (!nsInfo) return dbErr(404, `Namespace "${ns}" not found`);

        const onChainHead = nsInfo.head;
        const data = (cached?.head === onChainHead)
          ? cached.data
          : await fetchAndCache(client, ns, onChainHead, env.kv);

        const val = data[key] ?? null;
        if (val === null) return dbErr(404, `Record "${key}" not found in "${ns}"`);
        return dbOk({ key, val });
      }

      const val = await client.get(ns, key, { at });
      if (val === null) return dbErr(404, `Record "${key}" not found in "${ns}"`);
      return dbOk({ key, val });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Get failed';
      return dbErr(500, msg);
    }
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    try {
      const body = await request.json() as { val: JsonValue };
      if (body.val === undefined) return dbErr(400, 'Missing "val" field');
      const txHash = await client.set(ns, key, body.val);
      const doSnap = env.kv ? await afterWrite(client, ns, txHash, env.kv) : false;
      if (doSnap)    client.snapshot(ns).catch(() => { /* non-fatal */ });
      return dbOk({ txHash }, 201);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Set failed';
      return dbErr(400, msg);
    }
  }

  if (request.method === 'PATCH') {
    try {
      const body = await request.json() as { val: Record<string, JsonValue> };
      if (typeof body.val !== 'object' || body.val === null || Array.isArray(body.val)) {
        return dbErr(400, '"val" must be a plain object for PATCH');
      }
      const txHash = await client.merge(ns, key, body.val);
      const doSnap = env.kv ? await afterWrite(client, ns, txHash, env.kv) : false;
      if (doSnap)    client.snapshot(ns).catch(() => { /* non-fatal */ });
      return dbOk({ txHash });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Merge failed';
      return dbErr(400, msg);
    }
  }

  if (request.method === 'DELETE') {
    try {
      const txHash = await client.del(ns, key);
      const doSnap = env.kv ? await afterWrite(client, ns, txHash, env.kv) : false;
      if (doSnap)    client.snapshot(ns).catch(() => { /* non-fatal */ });
      return dbOk({ txHash });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Delete failed';
      return dbErr(400, msg);
    }
  }

  return dbErr(405, 'Method not allowed');
}

// ---------------------------------------------------------------------------
// Cache warming — call from a scheduled cron to refresh all known namespaces
// ---------------------------------------------------------------------------

/**
 * Refresh the KV state cache for every namespace currently stored in KV.
 * Compares each cached head against the on-chain head; only re-fetches if stale.
 * Safe to call from ctx.waitUntil — never throws.
 */
export async function warmDbCache(
  kv: KvCache,
  rpcUrl: string,
  dbAddress: string,
): Promise<void> {
  if (!kv.list) return; // list not available (e.g. in unit tests)
  try {
    const client = new HyberDBClient({
      rpcUrl,
      contractAddress: dbAddress as `0x${string}`,
    });

    const { keys } = await kv.list({ prefix: 'db:state:' });
    await Promise.all(keys.map(async ({ name: kvKey }) => {
      const ns = kvKey.slice('db:state:'.length);
      try {
        const [nsInfo, cached] = await Promise.all([
          client.info(ns),
          getCached(kv, ns),
        ]);
        if (!nsInfo) return; // namespace deleted on-chain
        if (cached?.head === nsInfo.head) return; // already fresh
        await fetchAndCache(client, ns, nsInfo.head, kv);
      } catch { /* non-fatal per namespace */ }
    }));
  } catch { /* non-fatal */ }
}
