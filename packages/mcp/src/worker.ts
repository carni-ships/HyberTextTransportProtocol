import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './createServer.js';
import { resolveSite, extractTar, ContentType } from './resolver.js';
import { handlePublish, type Env } from './upload.js';
import { landingPage } from './landing.js';

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

async function serveGateway(txHash: string, assetPath: string, rpcUrl: string): Promise<Response> {
  const decoded = await resolveSite(txHash as `0x${string}`, rpcUrl);

  const files: Map<string, Buffer> =
    decoded.contentType === ContentType.HTML
      ? new Map([['index.html', decoded.payload]])
      : await extractTar(decoded.payload);

  const key = assetPath.replace(/^\//, '') || 'index.html';
  const buf = files.get(key) ?? files.get(`${key.replace(/\/$/, '')}/index.html`);
  if (!buf) return new Response('Not found', { status: 404 });

  return new Response(buf, {
    headers: {
      'Content-Type': mimeType(key),
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-HyberText-TxHash': txHash,
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url    = new URL(request.url);
    const rpcUrl = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

    // ── MCP server ───────────────────────────────────────────────────────────
    if (url.pathname === '/mcp') {
      const server    = createServer(rpcUrl);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    // ── Publish endpoint ─────────────────────────────────────────────────────
    if (url.pathname === '/publish' && request.method === 'POST') {
      return handlePublish(request, env, url.origin);
    }

    // ── HTTP gateway  GET /0x{txhash}[/asset/path] ───────────────────────────
    const parts     = url.pathname.split('/').filter(Boolean);
    const txHash    = parts[0] ?? '';
    const assetPath = '/' + parts.slice(1).join('/');

    if (TX_HASH_RE.test(txHash)) {
      try {
        return await serveGateway(txHash, assetPath, rpcUrl);
      } catch (err: any) {
        return new Response(`Failed to resolve site: ${err.message}`, { status: 500 });
      }
    }

    // ── Landing page ─────────────────────────────────────────────────────────
    return new Response(landingPage(url.host), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  },
};
