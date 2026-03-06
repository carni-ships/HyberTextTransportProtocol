import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './createServer.js';

interface Env {
  BERACHAIN_RPC?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Only accept POST (MCP JSON-RPC) and GET (SSE stream) on /mcp
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    const rpcUrl = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

    // Stateless: create a fresh server + transport per request
    const server    = createServer(rpcUrl);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless mode
      enableJsonResponse: true,       // plain JSON responses, no SSE needed for tools
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
