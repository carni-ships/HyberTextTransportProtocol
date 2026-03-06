import * as zlib from 'zlib';
import { promisify } from 'util';
import { extract as tarExtract } from 'tar-stream';
import { Readable } from 'stream';
import { createPublicClient, http, defineChain } from 'viem';

// ---------------------------------------------------------------------------
// HYTE constants
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from([0x48, 0x59, 0x54, 0x45]); // "HYTE"
const HEADER_SIZE = 9;
export const Compression = { NONE: 0, GZIP: 1, BROTLI: 2 } as const;
export const ContentType  = { HTML: 0, TAR: 1, MANIFEST: 2 } as const;

// ---------------------------------------------------------------------------
// Berachain client
// ---------------------------------------------------------------------------

function makeClient(rpcUrl: string) {
  const berachain = defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Berascan', url: 'https://berascan.com' } },
  });
  return createPublicClient({ chain: berachain, transport: http(rpcUrl) });
}

// Lazily-initialized singleton keyed by RPC URL
const clients = new Map<string, ReturnType<typeof makeClient>>();
function getClient(rpcUrl: string) {
  if (!clients.has(rpcUrl)) clients.set(rpcUrl, makeClient(rpcUrl));
  return clients.get(rpcUrl)!;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

const brotliDecompress = promisify(zlib.brotliDecompress);
const gunzip = promisify(zlib.gunzip);

export async function fetchTxInput(txHash: `0x${string}`, rpcUrl: string): Promise<Buffer> {
  const tx = await getClient(rpcUrl).getTransaction({ hash: txHash });
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

export async function resolveSite(txHash: `0x${string}`, rpcUrl: string) {
  const raw    = await fetchTxInput(txHash, rpcUrl);
  const header = decodeHeader(raw);
  const body   = raw.subarray(HEADER_SIZE);

  if (header.contentType === ContentType.MANIFEST) {
    const manifest = JSON.parse(body.toString('utf8'));
    const chunks   = await Promise.all(
      manifest.chunks.map((h: string) => fetchTxInput(h as `0x${string}`, rpcUrl))
    );
    const payload = await decompress(Buffer.concat(chunks), manifest.compression);
    return { contentType: manifest.content_type as number, payload };
  }

  const payload = await decompress(body, header.compression);
  return { contentType: header.contentType as number, payload };
}

export async function extractTar(buf: Buffer): Promise<Map<string, Buffer>> {
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
