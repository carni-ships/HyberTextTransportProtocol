import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './createServer.js';
import { resolveSite, extractTar, ContentType } from './resolver.js';

interface Env {
  BERACHAIN_RPC?: string;
}

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

// Minimal MIME type lookup (avoids bundling mime-types in the Worker)
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

async function serveGateway(txHash: string, assetPath: string, rpcUrl: string): Promise<Response> {
  const decoded = await resolveSite(txHash as `0x${string}`, rpcUrl);

  const files: Map<string, Buffer> =
    decoded.contentType === ContentType.HTML
      ? new Map([['index.html', decoded.payload]])
      : await extractTar(decoded.payload);

  // Normalize path: strip leading slash, default to index.html
  const key = assetPath.replace(/^\//, '') || 'index.html';

  // Direct match, then directory index fallback
  const buf = files.get(key) ?? files.get(`${key.replace(/\/$/, '')}/index.html`);
  if (!buf) return new Response('Not found', { status: 404 });

  return new Response(buf, {
    headers: {
      'Content-Type': mimeType(key),
      // Sites are immutable — Cloudflare will cache at the edge
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-HyberText-TxHash': txHash,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const rpcUrl = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

    // ── MCP server ──────────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      const server    = createServer(rpcUrl);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    // ── HTTP gateway  GET /0x{txhash}[/asset/path] ──────────────────────────
    const parts    = url.pathname.split('/').filter(Boolean); // ['0xabc...', 'style.css']
    const txHash   = parts[0] ?? '';
    const assetPath = '/' + parts.slice(1).join('/');         // '/style.css' or '/'

    if (TX_HASH_RE.test(txHash)) {
      try {
        return await serveGateway(txHash, assetPath, rpcUrl);
      } catch (err: any) {
        return new Response(`Failed to resolve site: ${err.message}`, { status: 500 });
      }
    }

    // ── Landing page ─────────────────────────────────────────────────────────
    return new Response(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>HyberText Gateway</title>
  <style>body{font-family:monospace;max-width:640px;margin:4rem auto;padding:0 1rem}pre{background:#f0f0f0;padding:1rem;border-radius:6px;overflow-x:auto}</style>
</head>
<body>
  <h1>HyberText Gateway</h1>
  <p>Browse on-chain websites stored as Berachain calldata.</p>
  <h2>Browse a site</h2>
  <pre>https://${url.host}/0x{txhash}</pre>
  <h2>MCP endpoint (for Claude)</h2>
  <pre>https://${url.host}/mcp</pre>
  <h2>Demo site</h2>
  <pre><a href="/${  '0xfff68000dd4c9bc6198a9fa10959194fb8ea7f304b7b8afeb7f93ce3e0f1e80d'}">0xfff68000...e80d</a></pre>
</body>
</html>`,
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  },
};
