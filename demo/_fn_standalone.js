/**
 * Standalone Cloudflare Worker wrapper for the HyberText demo API.
 * Adapts native CF bindings to the gateway-injected env shape expected by _worker.js.
 *
 * Deploy via: npx wrangler@4 deploy --config fn-wrangler.toml _fn_standalone.js
 */

'use strict';

// ---------------------------------------------------------------------------
// Import the main worker logic (CommonJS shim)
// ---------------------------------------------------------------------------

// Inline the entire _worker.js logic here because wrangler bundles single files.
// See _worker.js for the full implementation.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function err(msg, status) {
  return json({ error: msg }, status || 400);
}

function apiPath(requestUrl) {
  const parts = new URL(requestUrl).pathname.split('/').filter(Boolean);
  const isTx  = parts[0] && parts[0].length === 66 && /^0x[0-9a-f]{64}$/i.test(parts[0]);
  return '/' + (isTx ? parts.slice(1) : parts).join('/');
}

const SESSION_SECRET = 'hybertext-demo-change-in-prod';

async function hmacKey(usage) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromb64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
}

async function signSession(payload) {
  const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const sig  = b64url(await crypto.subtle.sign('HMAC', await hmacKey('sign'), new TextEncoder().encode(body)));
  return `${body}.${sig}`;
}

async function verifySession(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  try {
    const sigBuf = Uint8Array.from(fromb64url(sig), c => c.charCodeAt(0));
    const valid  = await crypto.subtle.verify('HMAC', await hmacKey('verify'), sigBuf, new TextEncoder().encode(body));
    if (!valid) return null;
    const payload = JSON.parse(fromb64url(body.replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function handleInfo(req, env) {
  const hdrs = {};
  req.headers.forEach((v, k) => { hdrs[k] = v; });
  return json({
    ok:        true,
    method:    req.method,
    url:       req.url,
    path:      apiPath(req.url),
    time:      new Date().toISOString(),
    rpc:       env.rpc  ? (Array.isArray(env.rpc) ? env.rpc[0] : env.rpc) : 'not configured',
    db:        env.mcpBinding ? 'via gateway'     : 'not configured (set HYBERDB_ADDRESS)',
    kv:        env.kv        ? 'connected'       : 'not configured (bind EDGE_KV)',
    tableland: env.tableland ? 'available'       : 'not available',
    headers:   hdrs,
  });
}

async function handleEcho(req, env) {
  let body;
  const ct = req.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) {
    try { body = await req.json(); } catch { body = null; }
  } else {
    body = await req.text();
  }
  return json({ echo: body, method: req.method, time: new Date().toISOString() });
}

async function handleKvGet(req, env) {
  if (!env.kv) return err('KV not configured on this gateway. Bind EDGE_KV in wrangler.toml.', 503);
  const key = new URL(req.url).searchParams.get('key') || 'counter';
  const raw = await env.kv.get('demo:' + key);
  return json({ key, value: raw === null ? null : raw, found: raw !== null });
}

async function handleKvSet(req, env) {
  if (!env.kv) return err('KV not configured on this gateway. Bind EDGE_KV in wrangler.toml.', 503);
  const { key, value, ttl } = await req.json();
  if (!key) return err('key is required');
  const opts = ttl ? { expirationTtl: Number(ttl) } : undefined;
  await env.kv.put('demo:' + key, String(value), opts);
  return json({ ok: true, key, value: String(value), ttl: ttl || null });
}

async function handleKvIncrement(req, env) {
  if (!env.kv) return err('KV not configured on this gateway. Bind EDGE_KV in wrangler.toml.', 503);
  const { key = 'counter', by = 1 } = await req.json().catch(() => ({}));
  const fullKey  = 'demo:' + key;
  const current  = parseInt(await env.kv.get(fullKey) || '0', 10);
  const next     = current + Number(by);
  await env.kv.put(fullKey, String(next));
  return json({ key, previous: current, value: next, delta: Number(by) });
}

async function handleKvDelete(req, env) {
  if (!env.kv) return err('KV not configured on this gateway.', 503);
  const key = new URL(req.url).searchParams.get('key');
  if (!key) return err('key is required');
  if (typeof env.kv.delete === 'function') {
    await env.kv.delete('demo:' + key);
  } else {
    await env.kv.put('demo:' + key, '', { expirationTtl: 1 });
  }
  return json({ ok: true, key, deleted: true });
}

async function proxyDb(env, path, searchParams) {
  if (!env.mcpBinding && !env.GATEWAY_ORIGIN) {
    return null; // no gateway available
  }
  const origin = env.GATEWAY_ORIGIN || 'https://hybertext-mcp.carnation-903.workers.dev';
  const qs = searchParams.toString();
  const url = `${origin}/db/${path}${qs ? '?' + qs : ''}`;
  const res = env.mcpBinding
    ? await env.mcpBinding.fetch(new Request(url, { headers: { Accept: 'application/json' } }))
    : await fetch(url, { headers: { Accept: 'application/json' } });
  return res.json();
}

async function handleDbGet(req, env) {
  const url = new URL(req.url);
  // ns uses owner/collection format (e.g. "hybertext/demo")
  const ns  = url.searchParams.get('ns')  || 'hybertext/demo';
  const key = url.searchParams.get('key') || null;
  try {
    const dbPath = key ? `${ns}/${key}` : ns;
    const params = new URLSearchParams({ limit: '50' });
    const data = await proxyDb(env, dbPath, key ? new URLSearchParams() : params);
    if (!data) return err('HyberDB not configured on the gateway.', 503);
    if (key) {
      return json({ ns, key, value: data.val ?? null, found: data.val !== undefined });
    }
    return json({ ns, records: data.records, total: data.total });
  } catch (e) {
    return err(e.message || 'DB read failed', 500);
  }
}

async function handleDbInfo(req, env) {
  const ns = new URL(req.url).searchParams.get('ns') || 'hybertext/demo';
  try {
    const data = await proxyDb(env, `${ns}/_info`, new URLSearchParams());
    if (!data) return err('HyberDB not configured on the gateway.', 503);
    return json({ ns, info: data, exists: !data.error });
  } catch (e) {
    return err(e.message || 'DB info failed', 500);
  }
}

async function handleTableland(req, env) {
  if (!env.tableland) return err('Tableland not available.', 503);
  const sql = new URL(req.url).searchParams.get('sql');
  if (!sql) return err('sql query parameter is required');
  if (sql.length > 1000) return err('SQL query too long (max 1000 chars)');
  try {
    const result = await env.tableland.query(sql);
    return json({ ok: true, sql, result });
  } catch (e) {
    return err(e.message || 'Tableland query failed', 500);
  }
}

async function handleSessionCreate(req, env) {
  if (!env.kv) return err('KV required for sessions. Bind EDGE_KV in wrangler.toml.', 503);
  const { username } = await req.json().catch(() => ({}));
  if (!username || !String(username).trim()) return err('username is required');
  const safe = String(username).slice(0, 32).replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return err('username contains no valid characters');

  const id      = crypto.randomUUID();
  const exp     = Math.floor(Date.now() / 1000) + 3600;
  const payload = { id, username: safe, exp, iat: Math.floor(Date.now() / 1000) };
  const token   = await signSession(payload);

  await env.kv.put('demo:session:' + id, safe, { expirationTtl: 3600 });
  return json({ ok: true, token, username: safe, expiresIn: 3600 });
}

async function handleSessionVerify(req, env) {
  const token =
    (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') ||
    new URL(req.url).searchParams.get('token') || '';

  if (!token) return err('Provide token via Authorization: Bearer <token> or ?token=...', 401);

  const payload = await verifySession(token);
  if (!payload) return json({ ok: false, valid: false, reason: 'invalid or expired' }, 401);

  if (env.kv) {
    const stored = await env.kv.get('demo:session:' + payload.id);
    if (!stored) return json({ ok: false, valid: false, reason: 'session revoked' }, 401);
  }

  return json({ ok: true, valid: true, payload });
}

async function handleSessionDestroy(req, env) {
  const { token } = await req.json().catch(() => ({}));
  if (!token) return err('token is required');

  const payload = await verifySession(token);
  if (payload && env.kv) {
    if (typeof env.kv.delete === 'function') {
      await env.kv.delete('demo:session:' + payload.id);
    } else {
      await env.kv.put('demo:session:' + payload.id, '', { expirationTtl: 1 });
    }
  }
  return json({ ok: true, destroyed: true });
}

async function handleIndexQuery(req, env) {
  const url       = new URL(req.url);
  const limit     = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 50);
  const publisher = url.searchParams.get('publisher') || '';
  // Proxy to the main gateway's index endpoint.
  // Use HYBERTEXT_MCP service binding if available (avoids CF error 1042).
  const gatewayOrigin = env.GATEWAY_ORIGIN || 'https://hybertext-mcp.carnation-903.workers.dev';

  const params = new URLSearchParams({ limit: String(limit) });
  if (publisher) params.set('publisher', publisher);

  const indexUrl = `${gatewayOrigin}/index?${params}`;
  try {
    let res;
    if (env.mcpBinding) {
      // Worker-to-Worker via service binding (same account bypass)
      res = await env.mcpBinding.fetch(new Request(indexUrl, { headers: { Accept: 'application/json' } }));
    } else {
      res = await fetch(indexUrl, { headers: { Accept: 'application/json' } });
    }
    const data = await res.json();
    return json(data);
  } catch (e) {
    return err(e.message || 'Index query failed', 500);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const ROUTES = [
  ['GET',    '/api/info',            handleInfo],
  ['POST',   '/api/echo',            handleEcho],
  ['GET',    '/api/kv',              handleKvGet],
  ['POST',   '/api/kv',              handleKvSet],
  ['POST',   '/api/kv/increment',    handleKvIncrement],
  ['DELETE', '/api/kv',              handleKvDelete],
  ['GET',    '/api/db',              handleDbGet],
  ['GET',    '/api/db/info',         handleDbInfo],
  ['GET',    '/api/tableland',       handleTableland],
  ['POST',   '/api/session/create',  handleSessionCreate],
  ['GET',    '/api/session/verify',  handleSessionVerify],
  ['POST',   '/api/session/destroy', handleSessionDestroy],
  ['GET',    '/api/index',           handleIndexQuery],
];

// ---------------------------------------------------------------------------
// Cloudflare Worker export (ES module + CJS compatible)
// ---------------------------------------------------------------------------

async function handleRequest(request, cfEnv) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const path   = apiPath(request.url);
  const method = request.method.toUpperCase();

  // Adapt CF bindings to gateway-injected env shape
  const env = {
    kv:  cfEnv.EDGE_KV || null,
    rpc: cfEnv.BERACHAIN_RPC || 'https://rpc.berachain.com',
    tableland: {
      async query(sql) {
        const res = await fetch(
          `https://tableland.network/api/v1/query?statement=${encodeURIComponent(sql)}`,
          { headers: { Accept: 'application/json' } },
        );
        if (!res.ok) throw new Error(`Tableland query failed: HTTP ${res.status}`);
        return res.json();
      },
    },
    GATEWAY_ORIGIN: cfEnv.GATEWAY_ORIGIN,
    // Service binding for Worker-to-Worker calls (avoids CF error 1042)
    mcpBinding: cfEnv.HYBERTEXT_MCP || null,
  };

  for (const [m, p, handler] of ROUTES) {
    if (m === method && p === path) {
      try {
        return await handler(request, env);
      } catch (e) {
        return json({ error: e.message || 'Unexpected error' }, 500);
      }
    }
  }

  return json({ error: 'Route not found', path, method }, 404);
}

// Support both ES module and CommonJS export styles
if (typeof module !== 'undefined') {
  module.exports = { fetch: handleRequest };
}

export default { fetch: handleRequest };
