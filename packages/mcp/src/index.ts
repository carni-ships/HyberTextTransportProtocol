import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { extract as tarExtract } from 'tar-stream';
import { Readable } from 'stream';
import { createPublicClient, http, defineChain } from 'viem';

// ---------------------------------------------------------------------------
// HYTE constants (inlined from resolver to keep this package self-contained)
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
const HEADER_SIZE = 9;
const Compression = { NONE: 0, GZIP: 1, BROTLI: 2 } as const;
const ContentType  = { HTML: 0, TAR: 1, MANIFEST: 2 } as const;

// ---------------------------------------------------------------------------
// Berachain client
// ---------------------------------------------------------------------------

const RPC_URL = process.env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

const berachain = defineChain({
  id: 80094,
  name: 'Berachain',
  nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Berascan', url: 'https://berascan.com' } },
});

const client = createPublicClient({ chain: berachain, transport: http(RPC_URL) });

// ---------------------------------------------------------------------------
// Resolver logic
// ---------------------------------------------------------------------------

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

async function fetchTxInput(txHash: `0x${string}`): Promise<Buffer> {
  const tx = await client.getTransaction({ hash: txHash });
  if (!tx) throw new Error(`Transaction not found: ${txHash}`);
  const hex = tx.input.startsWith('0x') ? tx.input.slice(2) : tx.input;
  return Buffer.from(hex, 'hex');
}

function decodeHeader(raw: Buffer) {
  if (raw.length < HEADER_SIZE) throw new Error('Buffer too short for HYTE header');
  if (!raw.subarray(0, 4).equals(MAGIC))
    throw new Error(`Invalid HYTE magic: 0x${raw.subarray(0, 4).toString('hex')}`);
  return { version: raw[4], compression: raw[5], contentType: raw[6] };
}

async function decompress(buf: Buffer, compression: number): Promise<Buffer> {
  if (compression === Compression.BROTLI) return Buffer.from(await brotliDecompress(buf));
  if (compression === Compression.GZIP)   return Buffer.from(await gunzip(buf));
  return buf;
}

async function resolveSite(txHash: `0x${string}`) {
  const raw    = await fetchTxInput(txHash);
  const header = decodeHeader(raw);
  const body   = raw.subarray(HEADER_SIZE);

  if (header.contentType === ContentType.MANIFEST) {
    const manifest = JSON.parse(body.toString('utf8'));
    const chunks   = await Promise.all(
      manifest.chunks.map((h: string) => fetchTxInput(h as `0x${string}`))
    );
    const payload = await decompress(Buffer.concat(chunks), manifest.compression);
    return { contentType: manifest.content_type as number, payload };
  }

  const payload = await decompress(body, header.compression);
  return { contentType: header.contentType as number, payload };
}

async function extractTar(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    const files     = new Map<string, Buffer>();
    const extractor = tarExtract();

    extractor.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        if (header.type === 'file') {
          const path = header.name.replace(/^\.\//, '').replace(/^\//, '');
          files.set(path, Buffer.concat(chunks));
        }
        next();
      });
      stream.on('error', reject);
    });

    extractor.on('finish', () => resolve(files));
    extractor.on('error', reject);

    const readable = new Readable();
    readable.push(buf);
    readable.push(null);
    readable.pipe(extractor);
  });
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({ name: 'hybertext', version: '0.1.0' });

const TEXT_EXTENSIONS = /\.(html|htm|css|js|mjs|json|txt|md|svg|xml)$/i;
const MAX_FILE_BYTES  = 50 * 1024; // 50 KB per file — keeps context manageable

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
    const decoded = await resolveSite(txHash as `0x${string}`);

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

void (async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
