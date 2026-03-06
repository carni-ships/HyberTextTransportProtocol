import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeHeader,
  ContentType,
  Compression,
  VERSION,
  type CompressionType,
  type ContentTypeValue,
} from './format';
import { chunkBuffer, CHUNK_SIZE } from './pack';

// All site transactions go to this sink — value 0, calldata is the site
const SINK_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

const berachain = defineChain({
  id: 80094,
  name: 'Berachain',
  nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.berachain.com'] },
  },
  blockExplorers: {
    default: { name: 'Berascan', url: 'https://berascan.com' },
  },
});

export interface PublishOptions {
  rpcUrl: string;
  privateKey: `0x${string}`;
}

export async function publishSite(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  opts: PublishOptions
): Promise<`0x${string}`> {
  const account = privateKeyToAccount(opts.privateKey);
  const chain = { ...berachain, rpcUrls: { default: { http: [opts.rpcUrl] } } };

  const wallet = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl) });

  if (payload.length <= CHUNK_SIZE) {
    return publishSingle(payload, compression, contentType, wallet, pub);
  }
  return publishChunked(payload, compression, contentType, wallet, pub);
}

async function sendAndWait(
  data: `0x${string}`,
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>
): Promise<`0x${string}`> {
  const hash = await wallet.sendTransaction({ to: SINK_ADDRESS, data, value: 0n });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
}

async function publishSingle(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>
): Promise<`0x${string}`> {
  const header = encodeHeader({ version: VERSION, compression, contentType });
  const data = `0x${Buffer.concat([header, payload]).toString('hex')}` as `0x${string}`;
  return sendAndWait(data, wallet, pub);
}

async function publishChunked(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>
): Promise<`0x${string}`> {
  const chunks = chunkBuffer(payload);
  console.log(`  Large site detected: publishing ${chunks.length} chunks...`);

  const chunkHashes: `0x${string}`[] = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  Chunk ${i + 1}/${chunks.length}... `);
    const data = `0x${chunks[i].toString('hex')}` as `0x${string}`;
    const hash = await sendAndWait(data, wallet, pub);
    chunkHashes.push(hash);
    console.log(`done (${hash.slice(0, 10)}...)`);
  }

  // Publish the manifest transaction — its hash is the site's public address
  const manifest = JSON.stringify({
    v: 1,
    compression,
    content_type: contentType,
    chunks: chunkHashes,
    total_size: payload.length,
  });
  const header = encodeHeader({ version: VERSION, compression: Compression.NONE, contentType: ContentType.MANIFEST });
  const data = `0x${Buffer.concat([header, Buffer.from(manifest)]).toString('hex')}` as `0x${string}`;

  process.stdout.write('  Publishing manifest... ');
  const hash = await sendAndWait(data, wallet, pub);
  console.log('done');
  return hash;
}
