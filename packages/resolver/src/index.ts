import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { resolveSite } from './decode';
import { extractSite, resolveFile, type SiteFiles } from './serve';

const app = new Hono();
const PORT = Number(process.env.PORT ?? 3000);

// Immutable cache: txhash → extracted site files
// tx data never changes, so no expiry needed
const siteCache = new Map<string, SiteFiles>();

async function getSite(txHash: string): Promise<SiteFiles> {
  if (siteCache.has(txHash)) return siteCache.get(txHash)!;
  const decoded = await resolveSite(txHash as `0x${string}`);
  const site = await extractSite(decoded);
  siteCache.set(txHash, site);
  return site;
}

function isTxHash(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s);
}

function siteResponse(content: Buffer, mimeType: string, txHash: string): Response {
  return new Response(content, {
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
    const result = resolveFile(site.files, '/');
    if (!result) return c.text('index.html not found in site', 404);
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
    const result = resolveFile(site.files, assetPath);
    if (!result) return c.text('Not found', 404);
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
