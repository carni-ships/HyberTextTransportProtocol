import { createWalletClient, createPublicClient, http, defineChain, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encodePatch } from './format';
import type { DbPatch, RelayRequest, RelayEnv } from './types';

// ---------------------------------------------------------------------------
// Chain helper
// ---------------------------------------------------------------------------

function makeChain(rpcUrl: string) {
  return defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Berascan', url: 'https://berascan.com' } },
  });
}

const SINK      = '0x000000000000000000000000000000000000dEaD' as const;
const ZERO_HASH = '0x' + '0'.repeat(64);

// ---------------------------------------------------------------------------
// Minimal ABI for the calls we need
// ---------------------------------------------------------------------------

const ABI = [
  {
    name: 'getNamespace',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [
      {
        name: '', type: 'tuple',
        components: [
          { name: 'head',      type: 'bytes32' },
          { name: 'owner',     type: 'address' },
          { name: 'schema',    type: 'bytes32' },
          { name: 'updatedAt', type: 'uint64'  },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    name: 'getNonce',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }, { name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'getRole',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }, { name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    name: 'commitSigned',
    type: 'function',
    inputs: [
      { name: 'name',    type: 'string'  },
      { name: 'newHead', type: 'bytes32' },
      { name: 'signer',  type: 'address' },
      { name: 'nonce',   type: 'uint256' },
      { name: 'sig',     type: 'bytes'   },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'create',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }, { name: 'initialHead', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

// ---------------------------------------------------------------------------
// Raw RPC helpers
// ---------------------------------------------------------------------------

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message}`);
  return json.result;
}

// ---------------------------------------------------------------------------
// Relay handler
// ---------------------------------------------------------------------------

/**
 * Handle a gasless write relay request.
 * Validates the signer's role, publishes the patch tx, and calls commitSigned
 * (or create() for new namespaces).
 *
 * NOTE: In this MVP the signature covers the ops JSON (simple eth_sign message).
 * The on-chain commitSigned uses a separate EIP-712 sig path intended for direct
 * relayer use where the signer pre-signs the final txHash. The relay MVP uses
 * the simpler path: relayer calls commit() (not commitSigned) after verifying
 * the off-chain sig, because the txHash isn't known until the patch is published.
 * A production upgrade would use a two-step flow or a commit-queue contract.
 */
export async function handleRelay(req: RelayRequest, env: RelayEnv): Promise<{ txHash: string }> {
  const { ns, ops, signer, nonce, sig } = req;

  if (!ns || !ops || !signer || sig === undefined) {
    throw new Error('Missing required relay fields: ns, ops, signer, sig');
  }

  // ── Validate signature (simple eth_sign / personal_sign over JSON payload) ─
  const payload = JSON.stringify({ ns, ops, nonce });
  const isValid = await verifySignature(payload, sig, signer);
  if (!isValid) throw new Error('Invalid signature');

  // ── Check role via eth_call ───────────────────────────────────────────────
  // Selector: cast sig "getRole(string,address)" = 0x2d1ad1fa
  const roleResult = await rpcCall(env.rpcUrl, 'eth_call', [
    { to: env.contractAddress, data: encodeGetRoleCall(ns, signer) },
    'latest',
  ]) as string;
  // Role is a uint8 returned as a 32-byte padded value; read last byte
  const role = parseInt(roleResult.slice(-2), 16);
  if (role < 2) throw new Error(`Signer ${signer} does not have write access to "${ns}"`);

  // ── Verify nonce ─────────────────────────────────────────────────────────
  // Selector: cast sig "getNonce(string,address)" = 0x3969de4d
  const nonceResult = await rpcCall(env.rpcUrl, 'eth_call', [
    { to: env.contractAddress, data: encodeGetNonceCall(ns, signer) },
    'latest',
  ]) as string;
  const contractNonce = parseInt(nonceResult, 16);
  if (contractNonce !== nonce) throw new Error(`Nonce mismatch: expected ${contractNonce}, got ${nonce}`);

  // ── Get current head for prev pointer ────────────────────────────────────
  // Selector: cast sig "getNamespace(string)" = 0x73ceaebe
  const nsResult = await rpcCall(env.rpcUrl, 'eth_call', [
    { to: env.contractAddress, data: encodeGetNsCall(ns) },
    'latest',
  ]) as string;

  // The result is ABI-encoded tuple (bytes32, address, bytes32, uint64).
  // head is the first 32-byte slot (bytes 2..66 after the "0x" prefix).
  let prevHead: string | null = null;
  let isNewNs = true;
  if (nsResult && nsResult !== '0x' && nsResult.length >= 66) {
    const data  = nsResult.startsWith('0x') ? nsResult.slice(2) : nsResult;
    const head  = '0x' + data.slice(0, 64);
    const owner = data.slice(64 + 24, 128); // address: last 40 hex chars of second slot
    isNewNs  = owner === '0'.repeat(40);
    prevHead = (!isNewNs && head !== ZERO_HASH) ? head : null;
  }

  // ── Publish the patch tx ──────────────────────────────────────────────────
  const patch: DbPatch = { v: 1, prev: prevHead, ns, ops, ts: Date.now() };
  const patchPayload   = encodePatch(patch);

  const chain   = makeChain(env.rpcUrl);
  const account = privateKeyToAccount(env.privateKey);
  const wallet  = createWalletClient({ account, chain, transport: http(env.rpcUrl, { batch: false }) });
  const pub     = createPublicClient({ chain, transport: http(env.rpcUrl) });

  const walletNonceHex = await rpcCall(env.rpcUrl, 'eth_getTransactionCount', [account.address, 'pending']) as string;
  const gasPriceHex    = await rpcCall(env.rpcUrl, 'eth_gasPrice', []) as string;
  const walletNonce    = parseInt(walletNonceHex, 16);
  const gasPrice       = BigInt(gasPriceHex);
  const dataLen        = patchPayload.length;
  const gas            = BigInt((21_000 + dataLen * 30) * 4);

  const patchTxHash = await wallet.sendTransaction({
    to:       SINK,
    data:     `0x${patchPayload.toString('hex')}`,
    value:    0n,
    gas,
    gasPrice,
    nonce:    walletNonce,
  });

  await pub.waitForTransactionReceipt({ hash: patchTxHash });

  // ── Advance the head pointer ──────────────────────────────────────────────
  if (isNewNs) {
    // Use create() for a new namespace — relayer becomes the initial owner.
    // In practice the deployer should pre-create the namespace and grant the
    // relayer WRITER role, but this handles the bootstrap case.
    const createHash = await wallet.writeContract({
      address:      env.contractAddress,
      abi:          ABI,
      functionName: 'create',
      args:         [ns, patchTxHash as `0x${string}`],
    });
    await pub.waitForTransactionReceipt({ hash: createHash });
  } else {
    // Use commitSigned so the signer's authorisation is recorded on-chain.
    // The sig here authorises the relayer to call commitSigned on their behalf.
    const commitHash = await wallet.writeContract({
      address:      env.contractAddress,
      abi:          ABI,
      functionName: 'commitSigned',
      args:         [ns, patchTxHash as `0x${string}`, signer, BigInt(nonce), sig as `0x${string}`],
    });
    await pub.waitForTransactionReceipt({ hash: commitHash });
  }

  return { txHash: patchTxHash };
}

// ---------------------------------------------------------------------------
// Signature verification (eth_sign / personal_sign)
// ---------------------------------------------------------------------------

async function verifySignature(
  message: string,
  sig: string,
  expectedSigner: string,
): Promise<boolean> {
  try {
    return await verifyMessage({
      address:   expectedSigner as `0x${string}`,
      message,
      signature: sig as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manual ABI encoding for read-only eth_call payloads
// ---------------------------------------------------------------------------

/**
 * Encode a call with a single dynamic string parameter.
 * Layout: [4-byte selector][32-byte offset = 0x20][32-byte string length][padded string bytes]
 */
function encodeStringCall(selector: string, name: string): string {
  const nameBytes = Buffer.from(name, 'utf8');
  const padLen    = Math.ceil(nameBytes.length / 32) * 32;
  const buf       = Buffer.alloc(4 + 32 + 32 + padLen);
  Buffer.from(selector, 'hex').copy(buf, 0);
  // Offset to string data = 0x20 (the string data starts right after the offset slot)
  buf[4 + 31] = 0x20;
  // String length
  buf.writeUInt32BE(nameBytes.length, 4 + 32 + 28);
  // String bytes (zero-padded to 32-byte boundary)
  nameBytes.copy(buf, 4 + 32 + 32);
  return '0x' + buf.toString('hex');
}

/**
 * Encode a call with (string, address) parameters.
 * ABI layout: [selector][offset-to-string = 0x40][address (padded)][string length][string bytes]
 * The string offset is 0x40 because there are two head slots (offset + address) before the data.
 */
function encodeStringAddressCall(selector: string, name: string, addr: string): string {
  const nameBytes = Buffer.from(name, 'utf8');
  const padLen    = Math.ceil(nameBytes.length / 32) * 32;
  // 4 (selector) + 32 (offset to string) + 32 (address) + 32 (string length) + padLen (string data)
  const buf = Buffer.alloc(4 + 32 + 32 + 32 + padLen);
  Buffer.from(selector, 'hex').copy(buf, 0);
  // Offset to string data = 0x40 (skips the offset slot and the address slot)
  buf[4 + 31] = 0x40;
  // Address padded to 32 bytes (left-zero-padded, 20 bytes value at the right)
  Buffer.from(addr.replace(/^0x/, '').padStart(64, '0'), 'hex').copy(buf, 4 + 32);
  // String length
  buf.writeUInt32BE(nameBytes.length, 4 + 32 + 32 + 28);
  // String bytes
  nameBytes.copy(buf, 4 + 32 + 32 + 32);
  return '0x' + buf.toString('hex');
}

// Verified selectors (cast sig output):
//   getNamespace(string)       = 0x73ceaebe
//   getRole(string,address)    = 0x2d1ad1fa
//   getNonce(string,address)   = 0x3969de4d

function encodeGetNsCall(ns: string):                  string { return encodeStringCall('73ceaebe', ns); }
function encodeGetRoleCall(ns: string, addr: string):  string { return encodeStringAddressCall('2d1ad1fa', ns, addr); }
function encodeGetNonceCall(ns: string, addr: string): string { return encodeStringAddressCall('3969de4d', ns, addr); }
