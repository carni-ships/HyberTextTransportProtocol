/**
 * HyberACP — ERC-8183 Agentic Commerce Protocol helpers.
 *
 * Handles on-chain read/write to the HyberACP contract and defines the
 * TypeScript types that mirror the on-chain Job struct plus HyberDB metadata.
 */

import {
  createWalletClient,
  http,
  defineChain,
  encodeFunctionData,
  decodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Env } from './upload.js';

// ─── Chain ───────────────────────────────────────────────────────────────────

export function berachain(rpcUrl: string) {
  return defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ACPStatus = 'open' | 'funded' | 'submitted' | 'completed' | 'rejected' | 'expired';

/** On-chain Job struct decoded from getJob(uint256). */
export interface ACPJob {
  jobId:       string;   // decimal string
  client:      string;   // address
  provider:    string;   // address (zero if unset)
  evaluator:   string;   // address
  token:       string;   // ERC-20 address (zero if no payment)
  budget:      string;   // token units, decimal string
  expiredAt:   number;   // unix timestamp (0 = no expiry)
  status:      ACPStatus;
  hook:        string;   // address (zero if none)
  description: string;
  result:      string;   // hex-encoded bytes from submission
}

/** Rich off-chain metadata stored in HyberDB namespace `{workspace}/jobs`. */
export interface ACPJobMeta {
  jobId:       string;
  title:       string;
  workspace:   string;
  project:     string;
  priority:    'urgent' | 'high' | 'medium' | 'low';
  labels:      string[];
  deliverable: string | null;  // txHash of published result site
  createdAt:   number;
  updatedAt:   number;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS_MAP: ACPStatus[] = ['open', 'funded', 'submitted', 'completed', 'rejected', 'expired'];

export function decodeStatus(n: number): ACPStatus {
  return STATUS_MAP[n] ?? 'open';
}

// ─── Raw RPC ─────────────────────────────────────────────────────────────────

async function rpc(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`);
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

// ─── Contract reads ───────────────────────────────────────────────────────────

/** ABI-encoded selector for getJob(uint256) */
const SEL_GET_JOB   = '0x65c5e7c0'; // keccak256("getJob(uint256)")[0:4]
const SEL_JOB_COUNT = '0xb0f479a1'; // keccak256("jobCount()")[0:4]

/**
 * Compute 4-byte selector for a function signature.
 * We hard-code the selectors to avoid importing keccak256 deps in the Worker.
 */
function encodeUint256(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

export async function acpJobCount(rpcUrl: string, acpAddress: string): Promise<number> {
  const data = await rpc(rpcUrl, 'eth_call', [
    { to: acpAddress, data: SEL_JOB_COUNT },
    'latest',
  ]);
  if (!data || data === '0x') return 0;
  const [count] = decodeAbiParameters(parseAbiParameters('uint256'), data as Hex);
  return Number(count);
}

export async function acpReadJob(
  jobId: number | bigint,
  rpcUrl: string,
  acpAddress: string,
): Promise<ACPJob | null> {
  const calldata = SEL_GET_JOB + encodeUint256(BigInt(jobId));
  let data: unknown;
  try {
    data = await rpc(rpcUrl, 'eth_call', [{ to: acpAddress, data: calldata }, 'latest']);
  } catch {
    return null;
  }
  if (!data || data === '0x') return null;

  // Job struct ABI:
  // (address client, address provider, address evaluator, address token,
  //  uint128 budget, uint64 expiredAt, uint8 status, address hook,
  //  string description, bytes result)
  const decoded = decodeAbiParameters(
    parseAbiParameters(
      'address client, address provider, address evaluator, address token, uint128 budget, uint64 expiredAt, uint8 status, address hook, string description, bytes result',
    ),
    data as Hex,
  );

  return {
    jobId:       String(jobId),
    client:      decoded[0].toLowerCase(),
    provider:    decoded[1].toLowerCase(),
    evaluator:   decoded[2].toLowerCase(),
    token:       decoded[3].toLowerCase(),
    budget:      String(decoded[4]),
    expiredAt:   Number(decoded[5]),
    status:      decodeStatus(decoded[6]),
    hook:        decoded[7].toLowerCase(),
    description: decoded[8],
    result:      decoded[9],
  };
}

// ─── Contract writes ──────────────────────────────────────────────────────────

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function makeWalletClient(env: Env) {
  const rpcUrl  = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);
  return {
    rpcUrl,
    account,
    wallet: createWalletClient({
      account,
      chain: berachain(rpcUrl),
      transport: http(rpcUrl, { batch: false }),
    }),
  };
}

async function getNonceAndGasPrice(rpcUrl: string, address: string) {
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc(rpcUrl, 'eth_getTransactionCount', [address, 'pending']),
    rpc(rpcUrl, 'eth_gasPrice', []),
  ]);
  return {
    nonce:    parseInt(nonceHex as string, 16),
    gasPrice: BigInt(gasPriceHex as string),
  };
}

/** Send a write transaction to the HyberACP contract. */
export async function acpWrite(
  env: Env,
  calldata: Hex,
  gasLimit = 300_000n,
): Promise<Hex> {
  const acpAddress = env.ACP_ADDRESS as string;
  const { rpcUrl, account, wallet } = makeWalletClient(env);
  const { nonce, gasPrice } = await getNonceAndGasPrice(rpcUrl, account.address);

  return wallet.sendTransaction({
    to:       acpAddress as Hex,
    data:     calldata,
    gas:      gasLimit,
    gasPrice,
    nonce,
  });
}

/** Send an ERC-20 approve transaction. Returns txHash. */
export async function erc20Approve(
  env: Env,
  tokenAddress: string,
  spender: string,
  amount: bigint,
): Promise<Hex> {
  const calldata = encodeFunctionData({
    abi: [{ name: 'approve', type: 'function', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
    functionName: 'approve',
    args: [spender as Hex, amount],
  });
  const { rpcUrl, account, wallet } = makeWalletClient(env);
  const { nonce, gasPrice } = await getNonceAndGasPrice(rpcUrl, account.address);

  return wallet.sendTransaction({
    to:       tokenAddress as Hex,
    data:     calldata,
    gas:      80_000n,
    gasPrice,
    nonce,
  });
}

/** Wait for a transaction receipt (up to ~30s with 1s polling). */
export async function waitReceipt(rpcUrl: string, txHash: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1_000));
    const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]);
    if (receipt) return;
  }
  // Don't throw — tx may still land; caller has the hash
}

// ─── Calldata builders ────────────────────────────────────────────────────────

export function encodeCreateJob(
  provider:    string,
  evaluator:   string,
  token:       string,
  budget:      bigint,
  expiredAt:   number,
  description: string,
  hook:        string,
): Hex {
  return encodeFunctionData({
    abi: [{
      name: 'createJob',
      type: 'function',
      inputs: [
        { name: 'provider',    type: 'address' },
        { name: 'evaluator',   type: 'address' },
        { name: 'token',       type: 'address' },
        { name: 'budget',      type: 'uint128' },
        { name: 'expiredAt',   type: 'uint64'  },
        { name: 'description', type: 'string'  },
        { name: 'hook',        type: 'address' },
      ],
      outputs: [{ type: 'uint256' }],
    }],
    functionName: 'createJob',
    args: [
      provider  as Hex,
      evaluator as Hex,
      token     as Hex,
      budget,
      BigInt(expiredAt),
      description,
      hook      as Hex,
    ],
  });
}

export function encodeSetProvider(jobId: bigint, provider: string): Hex {
  return encodeFunctionData({
    abi: [{ name: 'setProvider', type: 'function', inputs: [{ type: 'uint256' }, { type: 'address' }], outputs: [] }],
    functionName: 'setProvider',
    args: [jobId, provider as Hex],
  });
}

export function encodeSetBudget(jobId: bigint, budget: bigint): Hex {
  return encodeFunctionData({
    abi: [{ name: 'setBudget', type: 'function', inputs: [{ type: 'uint256' }, { type: 'uint128' }], outputs: [] }],
    functionName: 'setBudget',
    args: [jobId, budget],
  });
}

export function encodeFund(jobId: bigint): Hex {
  return encodeFunctionData({
    abi: [{ name: 'fund', type: 'function', inputs: [{ type: 'uint256' }], outputs: [] }],
    functionName: 'fund',
    args: [jobId],
  });
}

export function encodeSubmit(jobId: bigint, result: string): Hex {
  return encodeFunctionData({
    abi: [{ name: 'submit', type: 'function', inputs: [{ type: 'uint256' }, { type: 'bytes' }], outputs: [] }],
    functionName: 'submit',
    args: [jobId, result as Hex],
  });
}

function toBytes32(hex: string): Hex {
  const clean = hex.replace(/^0x/i, '').slice(0, 64).padEnd(64, '0');
  return `0x${clean}` as Hex;
}

export function encodeComplete(jobId: bigint, reason: string): Hex {
  return encodeFunctionData({
    abi: [{ name: 'complete', type: 'function', inputs: [{ type: 'uint256' }, { type: 'bytes32' }], outputs: [] }],
    functionName: 'complete',
    args: [jobId, toBytes32(reason || '0x')],
  });
}

export function encodeReject(jobId: bigint, reason: string): Hex {
  return encodeFunctionData({
    abi: [{ name: 'reject', type: 'function', inputs: [{ type: 'uint256' }, { type: 'bytes32' }], outputs: [] }],
    functionName: 'reject',
    args: [jobId, toBytes32(reason || '0x')],
  });
}

export function encodeClaimRefund(jobId: bigint): Hex {
  return encodeFunctionData({
    abi: [{ name: 'claimRefund', type: 'function', inputs: [{ type: 'uint256' }], outputs: [] }],
    functionName: 'claimRefund',
    args: [jobId],
  });
}

// ─── JobCreated event parsing ─────────────────────────────────────────────────

/** Extract jobId from the JobCreated event in a transaction receipt.
 *  JobCreated(uint256 indexed jobId, address indexed client, address indexed evaluator, address provider)
 *  Topic[1] = jobId (indexed uint256)
 */
export async function getJobIdFromReceipt(
  rpcUrl: string,
  txHash: string,
  acpAddress: string,
): Promise<string | null> {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1_000));
    const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]) as any;
    if (!receipt) continue;

    const logs: any[] = receipt.logs ?? [];
    for (const log of logs) {
      if (log.address?.toLowerCase() !== acpAddress.toLowerCase()) continue;
      if (log.topics?.length >= 2) {
        // topics[1] is the indexed jobId
        return String(parseInt(log.topics[1], 16));
      }
    }
    return null;
  }
  return null;
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatJob(job: ACPJob, meta?: Partial<ACPJobMeta>): string {
  const lines: string[] = [];
  const zeroAddr = ZERO_ADDRESS;

  lines.push(`[J-${job.jobId}] ${meta?.title ?? job.description.slice(0, 80)}`);
  lines.push(`  status:    ${job.status.toUpperCase()}`);
  lines.push(`  client:    ${job.client}`);
  lines.push(`  provider:  ${job.provider === zeroAddr ? '(unset)' : job.provider}`);
  lines.push(`  evaluator: ${job.evaluator}`);

  if (job.budget !== '0') {
    const token = job.token === zeroAddr ? '(no token)' : job.token;
    lines.push(`  budget:    ${job.budget} wei  token: ${token}`);
  }
  if (job.expiredAt > 0) {
    lines.push(`  expires:   ${new Date(job.expiredAt * 1000).toISOString()}`);
  }
  if (meta?.project)     lines.push(`  project:   ${meta.project}`);
  if (meta?.priority)    lines.push(`  priority:  ${meta.priority}`);
  if (meta?.labels?.length) lines.push(`  labels:    ${meta.labels.join(', ')}`);
  if (meta?.deliverable) lines.push(`  result:    ${meta.deliverable}`);
  else if (job.result && job.result !== '0x') {
    try {
      const str = Buffer.from(job.result.slice(2), 'hex').toString('utf8');
      lines.push(`  result:    ${str.slice(0, 200)}`);
    } catch { /* binary result */ }
  }

  return lines.join('\n');
}

export { ZERO_ADDRESS };
