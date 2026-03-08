import { createHash } from 'node:crypto';
import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { eip7702Actions } from 'viem/experimental';
import { privateKeyToAccount } from 'viem/accounts';
import {
  encodeHeader,
  ContentType,
  Compression,
  VERSION,
  type CompressionType,
  type ContentTypeValue,
} from './format';
import { chunkBuffer, packFunctionCode, CHUNK_SIZE } from './pack';
import { rsEncode } from './rs';
import { generateCEK, encryptPayload, wrapCEK } from './encrypt';

// All site transactions go to this sink — value 0, calldata is the site
const SINK_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

// HyberIndex ABI fragment for publish(bytes32, uint8)
// Selector: cast sig "publish(bytes32,uint8)" = computed at runtime via encoding
const HYBERINDEX_ABI = [
  {
    name: 'publish',
    type: 'function',
    inputs: [
      { name: 'txHash',      type: 'bytes32' },
      { name: 'contentType', type: 'uint8'   },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

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
  /** Optional HyberIndex contract address — if set, announce publish on-chain. */
  indexAddress?: `0x${string}`;
  /**
   * EIP-7702: if set, announce to HyberIndex under this wallet's identity.
   * The wallet at `viaAddress` must have delegated to HyberDeployExecutor
   * and authorized `privateKey`'s address as its deploy key.
   * HyberIndex.Published will show viaAddress as the publisher.
   */
  viaAddress?:      `0x${string}`;
  executorAddress?: `0x${string}`;
}

export interface EncryptOptions {
  /** 32-byte hex X25519 public key of the target gateway's vault. */
  vaultPubkey:       string;
  /** HyberKeyVault contract address. */
  vaultAddress:      `0x${string}`;
  /** BERA access price in wei. */
  priceWei:          bigint;
  /** Key duration in seconds (0 = permanent). */
  keyDuration:       number;
  /** Address that receives BERA payments (defaults to publisher address). */
  paymentRecipient?: `0x${string}`;
}

// HyberKeyVault ABI fragment for register(bytes32, bytes, uint256, uint64)
const VAULT_ABI = [
  {
    name: 'register',
    type: 'function',
    inputs: [
      { name: 'siteTxHash',  type: 'bytes32' },
      { name: 'wrappedKey',  type: 'bytes'   },
      { name: 'priceWei',    type: 'uint256' },
      { name: 'keyDuration', type: 'uint64'  },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function publishSite(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  opts: PublishOptions,
): Promise<`0x${string}`> {
  const { wallet, pub } = makeClients(opts);
  if (payload.length <= CHUNK_SIZE) {
    const txHash = await publishSingle(payload, compression, contentType, wallet, pub);
    await announcePublish(txHash, contentType, opts, wallet, pub);
    return txHash;
  }
  return publishChunked(payload, compression, contentType, wallet, pub, undefined, opts);
}

/**
 * Publish a site with edge functions.
 * Sends one tx per function, then builds a manifest v3 pointing to them all.
 */
export async function publishWithFunctions(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  functions: Map<string, Buffer>, // routeKey → raw JS code
  opts: PublishOptions,
  /** Optional pre-deployed Worker URLs (routeKey → URL). Stored in manifest as fn_urls. */
  fnUrls?: Record<string, string>,
): Promise<`0x${string}`> {
  const { wallet, pub } = makeClients(opts);

  // Publish each function as its own FUNCTION-type tx (or chunked MANIFEST if large)
  const functionHashes: Record<string, string> = {};
  const fnHashes: Record<string, string> = {};
  for (const [routeKey, jsCode] of functions) {
    process.stdout.write(`  Function ${routeKey}... `);
    const singleTxData = await packFunctionCode(jsCode);

    if (singleTxData.length <= CHUNK_SIZE) {
      // Small function — single tx
      const hash = await sendAndWait(`0x${singleTxData.toString('hex')}` as `0x${string}`, wallet, pub);
      functionHashes[routeKey] = hash;
      fnHashes[routeKey] = sha256hex(singleTxData);
      console.log(`done (${hash.slice(0, 10)}...)`);
    } else {
      // Large function — publish as chunked MANIFEST with content_type=FUNCTION
      console.log(`chunking (${(singleTxData.length / 1024).toFixed(0)} KB)...`);
      const compressed     = singleTxData.subarray(9); // strip 9-byte HYTE header
      const fnCompression  = singleTxData[5] as CompressionType;
      const manifestHash = await publishChunked(
        compressed, fnCompression, ContentType.FUNCTION as ContentTypeValue,
        wallet, pub, undefined, undefined,
      );
      functionHashes[routeKey] = manifestHash;
      // no fnHash for chunked — verification happens at the chunk level
      console.log(`  Function ${routeKey} chunked (${manifestHash.slice(0, 10)}...)`);
    }
  }

  return publishChunked(payload, compression, contentType, wallet, pub, { functionHashes, fnHashes, fnUrls }, opts);
}

/**
 * Encrypt a site payload and publish it, then register the CEK in HyberKeyVault.
 * Returns the manifest/single tx hash (the "site address").
 */
export async function publishEncryptedSite(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  opts: PublishOptions & EncryptOptions,
): Promise<`0x${string}`> {
  const { wallet, pub } = makeClients(opts);

  // 1. Generate CEK and encrypt the payload
  const cek              = generateCEK();
  const encryptedPayload = encryptPayload(payload, cek);
  const wrappedKey       = wrapCEK(cek, Buffer.from(opts.vaultPubkey.replace(/^0x/, ''), 'hex'));

  // 2. Publish encrypted payload — content_type = ENCRYPTED, compression = original
  //    (compression field tells the resolver what to do AFTER decryption)
  process.stdout.write('Publishing encrypted site... ');
  const siteTxHash = await publishSite(encryptedPayload, compression, ContentType.ENCRYPTED as ContentTypeValue, {
    rpcUrl:       opts.rpcUrl,
    privateKey:   opts.privateKey,
    indexAddress: opts.indexAddress,
  });
  console.log(`done (${siteTxHash.slice(0, 12)}...)`);

  // 3. Register in HyberKeyVault
  process.stdout.write('Registering vault entry... ');
  const hash = await wallet.writeContract({
    address:      opts.vaultAddress,
    abi:          VAULT_ABI,
    functionName: 'register',
    args:         [
      siteTxHash as `0x${string}`,
      `0x${wrappedKey.toString('hex')}` as `0x${string}`,
      opts.priceWei,
      BigInt(opts.keyDuration),
    ],
  });
  await pub.waitForTransactionReceipt({ hash });
  console.log('done');

  return siteTxHash;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function makeClients(opts: PublishOptions) {
  const chain   = { ...berachain, rpcUrls: { default: { http: [opts.rpcUrl] } } };
  const account = privateKeyToAccount(opts.privateKey);
  const wallet  = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const pub     = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  return { wallet, pub };
}

async function sendAndWait(
  data: `0x${string}`,
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
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
  pub: ReturnType<typeof createPublicClient>,
): Promise<`0x${string}`> {
  const header = encodeHeader({ version: VERSION, compression, contentType });
  const data   = `0x${Buffer.concat([header, payload]).toString('hex')}` as `0x${string}`;
  return sendAndWait(data, wallet, pub);
}

async function publishChunked(
  payload: Buffer,
  compression: CompressionType,
  contentType: ContentTypeValue,
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
  fnInfo?: { functionHashes: Record<string, string>; fnHashes: Record<string, string>; fnUrls?: Record<string, string> },
  opts?: PublishOptions,
): Promise<`0x${string}`> {
  const rawChunks = chunkBuffer(payload);
  const k         = rawChunks.length;
  // Add up to 4 parity chunks (25% overhead, min 1 parity if more than 1 data chunk)
  const p         = k > 1 ? Math.min(Math.ceil(k / 4), 4) : 0;

  if (k > 1) console.log(`  Chunking: ${k} data chunks + ${p} parity chunks...`);

  // ── Publish data chunks ───────────────────────────────────────────────────
  const chunkHashes: `0x${string}`[] = [];
  const chunkSha256: string[]         = [];

  for (let i = 0; i < k; i++) {
    if (k > 1) process.stdout.write(`  Chunk ${i + 1}/${k}... `);
    const data = `0x${rawChunks[i].toString('hex')}` as `0x${string}`;
    const hash = await sendAndWait(data, wallet, pub);
    chunkHashes.push(hash);
    chunkSha256.push(sha256hex(rawChunks[i]));
    if (k > 1) console.log(`done (${hash.slice(0, 10)}...)`);
  }

  // ── Compute + publish RS parity chunks ───────────────────────────────────
  const parityHashes: `0x${string}`[] = [];

  if (p > 0) {
    // Pad all chunks to CHUNK_SIZE for RS arithmetic (parity is always CHUNK_SIZE)
    const padded = rawChunks.map(c => {
      if (c.length === CHUNK_SIZE) return c;
      const buf = Buffer.alloc(CHUNK_SIZE);
      c.copy(buf);
      return buf;
    });

    const parityBufs = rsEncode(padded, p);

    for (let i = 0; i < p; i++) {
      process.stdout.write(`  Parity ${i + 1}/${p}... `);
      const data = `0x${parityBufs[i].toString('hex')}` as `0x${string}`;
      const hash = await sendAndWait(data, wallet, pub);
      parityHashes.push(hash);
      console.log(`done (${hash.slice(0, 10)}...)`);
    }
  }

  // ── Build manifest v3 ─────────────────────────────────────────────────────
  const hasFunctions = fnInfo && Object.keys(fnInfo.functionHashes).length > 0;
  const hasFnUrls = fnInfo?.fnUrls && Object.keys(fnInfo.fnUrls).length > 0;
  const manifest = JSON.stringify({
    v: 3,
    compression,
    content_type: contentType,
    k,
    chunks:     chunkHashes,
    hashes:     chunkSha256,
    ...(parityHashes.length > 0 ? { parity: parityHashes } : {}),
    total_size: payload.length,
    ...(hasFunctions ? { functions: fnInfo!.functionHashes } : {}),
    ...(hasFunctions ? { fn_hashes: fnInfo!.fnHashes } : {}),
    ...(hasFnUrls   ? { fn_urls:   fnInfo!.fnUrls }    : {}),
  });

  const header = encodeHeader({
    version:     VERSION,
    compression: Compression.NONE,
    contentType: ContentType.MANIFEST,
  });
  const data = `0x${Buffer.concat([header, Buffer.from(manifest)]).toString('hex')}` as `0x${string}`;

  process.stdout.write('  Publishing manifest... ');
  const manifestHash = await sendAndWait(data, wallet, pub);
  console.log('done');

  // ── Announce on HyberIndex ────────────────────────────────────────────────
  if (opts) await announcePublish(manifestHash, ContentType.MANIFEST, opts, wallet, pub);

  return manifestHash;
}

// HyberDeployExecutor ABI for EIP-7702 delegated publishing
const EXECUTOR_ABI = [
  {
    name: 'publishToIndex',
    type: 'function',
    inputs: [
      { name: 'txHash',       type: 'bytes32' },
      { name: 'contentType',  type: 'uint8'   },
      { name: 'indexAddress', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

/** Call HyberIndex.publish() if an index address is configured.
 *  Uses EIP-7702 delegated call when opts.viaAddress is set. */
async function announcePublish(
  txHash: `0x${string}`,
  contentType: number,
  opts: PublishOptions,
  wallet: ReturnType<typeof createWalletClient>,
  pub: ReturnType<typeof createPublicClient>,
): Promise<void> {
  if (!opts.indexAddress || opts.indexAddress === '0x0000000000000000000000000000000000000000') return;
  try {
    process.stdout.write('  Announcing to HyberIndex... ');

    let hash: `0x${string}`;

    if (opts.viaAddress) {
      // EIP-7702 path: deploy key calls viaAddress.publishToIndex(...)
      // HyberIndex sees msg.sender = viaAddress (the main wallet identity)
      hash = await wallet.writeContract({
        address:      opts.viaAddress,
        abi:          EXECUTOR_ABI,
        functionName: 'publishToIndex',
        args:         [txHash as `0x${string}`, contentType, opts.indexAddress],
      });
    } else {
      // Standard path: wallet calls HyberIndex.publish() directly
      hash = await wallet.writeContract({
        address:      opts.indexAddress,
        abi:          HYBERINDEX_ABI,
        functionName: 'publish',
        args:         [txHash as `0x${string}`, contentType],
      });
    }

    await pub.waitForTransactionReceipt({ hash });
    console.log('done');
  } catch (e: any) {
    // Non-fatal — the site is published regardless
    console.log(`skipped (${e.message ?? 'unknown error'})`);
  }
}

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
