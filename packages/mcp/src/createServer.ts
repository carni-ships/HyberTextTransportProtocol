import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveSite, extractTar, ContentType } from './resolver.js';

const TEXT_EXTENSIONS = /\.(html|htm|css|js|mjs|json|txt|md|svg|xml)$/i;
const MAX_FILE_BYTES  = 50 * 1024; // 50 KB per file

export function createServer(rpcUrl: string): McpServer {
  const server = new McpServer({ name: 'hybertext', version: '0.1.0' });

  server.tool(
    'fetch_hybertext_site',
    `Fetch and read a website stored as calldata on Berachain (HyberText format).
Returns a file listing and the text content of all readable files (HTML, CSS, JS, etc.).
Binary files are listed but their content is omitted.`,
    {
      txHash: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 0x-prefixed 64-hex-char tx hash')
        .describe('Berachain transaction hash that stores the site (0x...)'),
    },
    async ({ txHash }) => {
      const decoded = await resolveSite(txHash as `0x${string}`, rpcUrl);

      const files: Map<string, Buffer> =
        decoded.contentType === ContentType.HTML
          ? new Map([['index.html', decoded.payload]])
          : await extractTar(decoded.payload);

      const lines: string[] = [];
      lines.push(`HyberText site @ ${txHash}`);
      lines.push(`${files.size} file(s):\n`);

      for (const [path, buf] of files) {
        lines.push(`  ${path}  (${buf.length.toLocaleString()} bytes)`);
      }

      for (const [path, buf] of files) {
        if (!TEXT_EXTENSIONS.test(path)) continue;

        lines.push(`\n${'─'.repeat(60)}`);
        lines.push(`FILE: ${path}`);
        lines.push('─'.repeat(60));

        if (buf.length <= MAX_FILE_BYTES) {
          lines.push(buf.toString('utf8'));
        } else {
          lines.push(buf.subarray(0, MAX_FILE_BYTES).toString('utf8'));
          lines.push(`\n[... truncated — file is ${buf.length.toLocaleString()} bytes, showing first 50 KB]`);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  return server;
}
