import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { resolveSite, resolveFunctionCode } from './decode';
import { extractSite, resolveFile, type SiteFiles } from './serve';

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3000);

// Immutable cache: txhash → extracted site
// tx data never changes, so no expiry needed
interface CachedSite extends SiteFiles {
  functions?: Record<string, string>;
  fnHashes?:  Record<string, string>;
}
const siteCache = new Map<string, CachedSite>();

async function getSite(txHash: string): Promise<CachedSite> {
  if (siteCache.has(txHash)) return siteCache.get(txHash)!;
  const decoded = await resolveSite(txHash as `0x${string}`);
  const site = await extractSite(decoded);
  const cached: CachedSite = { ...site, functions: decoded.functions, fnHashes: decoded.fnHashes };
  siteCache.set(txHash, cached);
  return cached;
}

/** Match a path against a route pattern with [param] and [...rest] segments. */
function matchRoute(pattern: string, urlPath: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const up = urlPath.replace(/^\//, '').split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i];
    if (seg.startsWith('[...') && seg.endsWith(']')) {
      params[seg.slice(4, -1)] = up.slice(i).join('/');
      return params;
    }
    if (seg.startsWith('[') && seg.endsWith(']')) {
      if (i >= up.length) return null;
      params[seg.slice(1, -1)] = up[i];
    } else {
      if (up[i] !== seg) return null;
    }
  }
  return pp.length === up.length ? params : null;
}

/** Execute a function stored on-chain. Uses new Function (safe in Node.js). */
async function callFunction(
  fnTxHash: string, params: Record<string, string>, request: Request, expectedHash?: string,
): Promise<Response> {
  const code    = await resolveFunctionCode(fnTxHash as `0x${string}`, expectedHash);
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', code + '\n;return module.exports;');
  const mod: any = {};
  const handler = factory(mod, {});
  const fn = handler?.default?.fetch ?? handler?.fetch ?? (typeof handler === 'function' ? handler : null);
  if (typeof fn !== 'function') throw new Error('Function has no fetch export');
  return fn(request, { params }) as Promise<Response>;
}

function isTxHash(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s);
}

function siteResponse(content: Buffer, mimeType: string, txHash: string): Response {
  const base = `/${txHash}`;
  let body: BodyInit = content;

  if (mimeType.startsWith('text/html')) {
    let html = content.toString('utf8')
      .replace(/((?:href|src|action|data-src|data-href|content|poster)=["'])\//g, `$1${base}/`)
      .replace(/url\(\//g, `url(${base}/`)
      .replace(/@import\s+["']\//g, `@import "${base}/`);
    if (!html.includes('<base ')) {
      html = html.replace(/(<head[^>]*>)/i, `$1<base href="${base}/">`);
    }
    body = html;
  } else if (mimeType === 'text/css') {
    body = content.toString('utf8')
      .replace(/url\(\//g, `url(${base}/`)
      .replace(/@import\s+["']\//g, `@import "${base}/`);
  }

  return new Response(body, {
    headers: {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-HyberText-TxHash': txHash,
    },
  });
}

// Landing page
app.get('/', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HyberText Gateway</title>
  <style>
    body { font-family: monospace; max-width: 640px; margin: 4rem auto; padding: 0 1rem; }
    code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; }
    pre  { background: #f0f0f0; padding: 1rem; border-radius: 6px; overflow-x: auto; }
  </style>
</head>
<body>
  <h1>HyberText Gateway</h1>
  <p>Access on-chain websites stored as Berachain calldata.</p>
  <h2>Usage</h2>
  <pre>GET /{txhash}             — serve site root (index.html)
GET /{txhash}/path/to/file — serve asset from tar site</pre>
  <h2>Publish</h2>
  <pre>cd packages/cli &amp;&amp; node dist/index.js publish ./my-site/ --key $PRIVATE_KEY</pre>
  <p>The returned tx hash is the permanent address of your site.</p>
</body>
</html>`);
});

// Serve site root: GET /0x{txhash}
app.get('/:txhash', async (c) => {
  const txhash = c.req.param('txhash');
  if (!isTxHash(txhash)) return c.text('Invalid tx hash format', 400);

  try {
    const site = await getSite(txhash);

    // Check specific function routes, then fall back to static
    if (site.functions) {
      for (const [pattern, fnTxHash] of Object.entries(site.functions)) {
        if (pattern === '_worker') continue;
        const params = matchRoute(pattern, '/');
        if (params) return await callFunction(fnTxHash, params, c.req.raw, site.fnHashes?.[pattern]);
      }
    }

    const result = resolveFile(site.files, '/');
    if (!result) {
      if (site.functions?.['_worker']) return await callFunction(site.functions['_worker'], {}, c.req.raw, site.fnHashes?.['_worker']);
      return c.text('index.html not found in site', 404);
    }
    return siteResponse(result.content, result.mimeType, txhash);
  } catch (err: any) {
    console.error(`[${txhash.slice(0, 10)}] ${err.message}`);
    return c.text(`Failed to resolve site: ${err.message}`, 500);
  }
});

// Serve site assets: GET /0x{txhash}/path/to/asset.css
app.get('/:txhash/*', async (c) => {
  const txhash = c.req.param('txhash');
  if (!isTxHash(txhash)) return c.text('Invalid tx hash format', 400);

  const assetPath = c.req.path.slice(txhash.length + 1) || '/';

  try {
    const site = await getSite(txhash);

    // Check specific function routes first
    if (site.functions) {
      for (const [pattern, fnTxHash] of Object.entries(site.functions)) {
        if (pattern === '_worker') continue;
        const params = matchRoute(pattern, assetPath);
        if (params) return await callFunction(fnTxHash, params, c.req.raw, site.fnHashes?.[pattern]);
      }
    }

    const result = resolveFile(site.files, assetPath);
    if (!result) {
      if (site.functions?.['_worker']) return await callFunction(site.functions['_worker'], {}, c.req.raw, site.fnHashes?.['_worker']);
      return c.text('Not found', 404);
    }
    return siteResponse(result.content, result.mimeType, txhash);
  } catch (err: any) {
    console.error(`[${txhash.slice(0, 10)}] ${err.message}`);
    return c.text(`Failed to resolve asset: ${err.message}`, 500);
  }
});

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`HyberText resolver running on http://localhost:${PORT}`);
  console.log(`Access sites: http://localhost:${PORT}/0x{txhash}`);
});
