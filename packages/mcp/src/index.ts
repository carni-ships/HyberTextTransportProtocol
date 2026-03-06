import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './createServer.js';

const RPC_URL = process.env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

void (async () => {
  const server    = createServer(RPC_URL);
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
