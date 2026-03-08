/**
 * index-query.ts — Decentralized site index via HyberIndex event log.
 *
 * Primary path: eth_getLogs on HyberIndex.Published events.
 * No server state required — the chain IS the index.
 *
 * Snapshot path (background, optional):
 *   Gateways periodically publish a compressed JSON snapshot as calldata
 *   (ContentType.INDEX = 5) and announce it via HyberIndex.
 *   To find the latest snapshot: eth_getLogs filtered by publisher address.
 *   If the snapshot is pruned or stale, fall back to eth_getLogs.
 */

import { keccak_256 } from '@noble/hashes/sha3';

// ---------------------------------------------------------------------------
// Published event topic
// ---------------------------------------------------------------------------

// keccak256("Published(address,bytes32,uint8,uint64)")
// Verify: cast sig-event "Published(address,bytes32,uint8,uint64)"
const PUBLISHED_TOPIC: string = (() => {
  const h = keccak_256(new TextEncoder().encode('Published(address,bytes32,uint8,uint64)'));
  return '0x' + Array.from(h).map(b => b.toString(16).padStart(2, '0')).join('');
})();

// HyberIndex.publish(bytes32,uint8) selector = keccak256("publish(bytes32,uint8)")[0..3]
// Computed: 0x65b38482  (same as upload.ts)
const HYBERINDEX_PUBLISH_SELECTOR = '65b38482';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexEntry {
  txHash:      string;  // 0x-prefixed site tx hash
  publisher:   string;  // 0x-prefixed address
  contentType: number;  // HYTE content type (2=MANIFEST, 5=INDEX snapshot, 8=ENCRYPTED, etc.)
  timestamp:   number;  // unix seconds
  blockNumber: number;
}

interface RpcLog {
  topics:      string[];
  data:        string;
  blockNumber: string;
}

// ---------------------------------------------------------------------------
// Core query (eth_getLogs)
// ---------------------------------------------------------------------------

const MAX_BLOCK_RANGE = 9_000; // Berachain eth_getLogs limit is 10,000; stay under it

export async function queryIndex(
  indexAddress: string,
  rpcUrl:       string,
  options: {
    publisher?:  string;           // filter by publisher address
    fromBlock?:  string | number;
    toBlock?:    string | number;
    limit?:      number;           // max results (most recent first), default 100
  } = {},
): Promise<IndexEntry[]> {
  const { publisher, fromBlock = '0x0', toBlock = 'latest', limit = 100 } = options;

  const topics: (string | null)[] = [PUBLISHED_TOPIC];
  if (publisher) {
    // topic[1] = indexed publisher address, left-padded to 32 bytes
    topics.push('0x' + publisher.replace(/^0x/, '').toLowerCase().padStart(64, '0'));
  }

  // Resolve 'latest' toBlock to a concrete number so we can paginate
  let toBlockNum: number;
  if (toBlock === 'latest') {
    const res = await fetch(rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
    });
    const json = await res.json() as { result?: string };
    toBlockNum = parseInt(json.result ?? '0x0', 16);
  } else {
    toBlockNum = typeof toBlock === 'number' ? toBlock : parseInt(toBlock as string, 16);
  }

  let fromBlockNum = typeof fromBlock === 'number' ? fromBlock : parseInt(fromBlock as string, 16);

  // Collect all logs across paginated chunks
  const allLogs: RpcLog[] = [];
  while (fromBlockNum <= toBlockNum) {
    const chunkTo = Math.min(fromBlockNum + MAX_BLOCK_RANGE - 1, toBlockNum);
    const res = await fetch(rpcUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0',
        method:  'eth_getLogs',
        params:  [{
          address:   indexAddress,
          topics,
          fromBlock: '0x' + fromBlockNum.toString(16),
          toBlock:   '0x' + chunkTo.toString(16),
        }],
        id: 1,
      }),
    });
    if (!res.ok) throw new Error(`eth_getLogs HTTP ${res.status}`);
    const json = await res.json() as { result?: RpcLog[]; error?: { message: string } };
    if (json.error) throw new Error(json.error.message);
    allLogs.push(...(json.result ?? []));
    fromBlockNum = chunkTo + 1;
  }

  // Return most-recent-first, capped at limit
  return allLogs.slice(-limit).reverse().map(parsePublishedLog);
}

function parsePublishedLog(log: RpcLog): IndexEntry {
  // topic[1] = publisher address (indexed, left-padded to 32 bytes)
  // topic[2] = txHash (indexed bytes32)
  // data = abi.encode(uint8 contentType, uint64 timestamp) = 64 bytes
  const publisher = '0x' + log.topics[1].slice(-40);
  const txHash    = log.topics[2];

  const d = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  // First 32-byte word: uint8 contentType, right-aligned → last 2 hex chars
  const contentType = parseInt(d.slice(62, 64), 16);
  // Second 32-byte word: uint64 timestamp, right-aligned → last 16 hex chars
  const timestamp   = parseInt(d.slice(64 + 48, 128), 16);

  return { txHash, publisher, contentType, timestamp, blockNumber: parseInt(log.blockNumber, 16) };
}

// ---------------------------------------------------------------------------
// Snapshot publishing (background — stores fresh index as calldata)
// ---------------------------------------------------------------------------

// In-memory timestamp of last snapshot publish (per Worker instance)
let lastSnapshotAt = 0;
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Publish a fresh index snapshot in the background.
 * The snapshot is a gzip-compressed JSON blob stored as HYTE calldata (ContentType.INDEX = 5).
 * It is announced to HyberIndex so anyone can discover it via eth_getLogs filtered by
 * the gateway's publisher address.
 *
 * Set force=true to bypass the in-memory rate-limit (e.g. from a scheduled cron).
 * Safe to call with ctx.waitUntil — never throws.
 */
export async function maybePublishSnapshot(
  entries:      IndexEntry[],
  indexAddress: string,
  rpcUrl:       string,
  privateKey:   string,
  force = false,
): Promise<void> {
  const now = Date.now();
  if (!force && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return;
  lastSnapshotAt = now;

  try {
    const payload = await buildSnapshotPayload(entries);
    await sendSnapshotAndAnnounce(payload, indexAddress, rpcUrl, privateKey);
  } catch {
    // Non-fatal — the live eth_getLogs path always works
  }
}

/** Gzip compress using CompressionStream (Cloudflare Workers / modern browsers). */
async function gzipData(data: Uint8Array): Promise<Uint8Array> {
  const cs     = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writer.write(data as any);
  writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    chunks.push(value as any);
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c as Uint8Array<ArrayBuffer>, off); off += c.length; }
  return out;
}

async function buildSnapshotPayload(entries: IndexEntry[]): Promise<Uint8Array> {
  const jsonBytes = new TextEncoder().encode(
    JSON.stringify({ v: 1, generated: Math.floor(Date.now() / 1000), entries }),
  );

  // Try to gzip; fall back to uncompressed if CompressionStream is unavailable
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any   = jsonBytes;
  let compression = 0x00; // NONE
  try {
    body        = await gzipData(jsonBytes);
    compression = 0x01; // GZIP
  } catch { /* uncompressed fallback */ }

  const header = new Uint8Array(9);
  header[0] = 0x48; header[1] = 0x59; header[2] = 0x54; header[3] = 0x45; // HYTE
  header[4] = 0x01; // version
  header[5] = compression;
  header[6] = 0x05; // contentType = INDEX
  return concat(header, body);
}

/**
 * Parse a snapshot payload from calldata (skips 9-byte HYTE header).
 * Returns null if the payload can't be decoded.
 */
export function parseSnapshot(calldata: Uint8Array): IndexEntry[] | null {
  try {
    // Compression byte is header[5]; parse but don't decompress here (caller handles it)
    const body = calldata.slice(9);
    const json = new TextDecoder().decode(body);
    const obj  = JSON.parse(json) as { entries?: IndexEntry[] };
    return obj.entries ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot tx helpers
// ---------------------------------------------------------------------------

async function rpcPost(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

/**
 * Send the snapshot blob tx and the announce tx in sequence using consecutive nonces.
 * Fetches nonce once and increments locally to avoid the nonce-collision bug that
 * would occur if both txs fetched eth_getTransactionCount independently.
 */
async function sendSnapshotAndAnnounce(
  payload:      Uint8Array,
  indexAddress: string,
  rpcUrl:       string,
  privateKey:   string,
): Promise<void> {
  const { createWalletClient, http, defineChain } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');

  const chain   = defineChain({ id: 80094, name: 'Berachain', nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const wallet  = createWalletClient({ account, chain, transport: http(rpcUrl, { batch: false }) });

  // Fetch nonce and gas price once — reuse for both txs to avoid nonce collision
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpcPost(rpcUrl, 'eth_getTransactionCount', [account.address, 'pending']),
    rpcPost(rpcUrl, 'eth_gasPrice', []),
  ]);
  const baseNonce = parseInt(nonceHex as string, 16);
  const gasPrice  = BigInt(gasPriceHex as string);

  // Tx 1: snapshot blob
  const blobData = ('0x' + Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
  const blobGas  = BigInt((21_000 + payload.length * 30) * 4);
  const snapshotHash = await wallet.sendTransaction({
    to: '0x000000000000000000000000000000000000dEaD',
    data: blobData, value: 0n, gas: blobGas, gasPrice, nonce: baseNonce,
  });

  // Tx 2: announce to HyberIndex — nonce+1, no need to wait for tx1 confirmation
  const hash32       = snapshotHash.slice(2).padStart(64, '0');
  const ctPadded     = '0000000000000000000000000000000000000000000000000000000000000005';
  const announceData = ('0x' + HYBERINDEX_PUBLISH_SELECTOR + hash32 + ctPadded) as `0x${string}`;
  await wallet.sendTransaction({
    to: indexAddress as `0x${string}`,
    data: announceData, value: 0n, gas: 80_000n, gasPrice, nonce: baseNonce + 1,
  });
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
