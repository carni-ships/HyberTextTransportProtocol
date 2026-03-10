/**
 * ERC-8004 — Agent Identity & Reputation helpers.
 *
 * Mirrors acp.ts in structure: raw RPC reads + viem-encoded writes.
 * Three registries:
 *   HyberAgentIdentity  — ERC-721 identity tokens
 *   HyberAgentReputation — signed feedback (int128, 18 decimals)
 *   HyberACPRepHook     — afterAction hook wiring ERC-8183 → ERC-8004 on-chain
 */

import {
  createWalletClient,
  http,
  encodeFunctionData,
  decodeAbiParameters,
  parseAbiParameters,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { berachain } from './acp.js';
import type { Env } from './upload.js';

// ─── Raw RPC ──────────────────────────────────────────────────────────────────

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

// ─── Wallet client ────────────────────────────────────────────────────────────

function makeWalletClient(env: Env) {
  const rpcUrl  = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);
  return {
    rpcUrl,
    account,
    wallet: createWalletClient({
      account,
      chain:     berachain(rpcUrl),
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

async function contractWrite(env: Env, contractAddress: string, calldata: Hex, gasLimit = 400_000n): Promise<Hex> {
  const { rpcUrl, account, wallet } = makeWalletClient(env);
  const { nonce, gasPrice } = await getNonceAndGasPrice(rpcUrl, account.address);
  return wallet.sendTransaction({
    to:       contractAddress as Hex,
    data:     calldata,
    gas:      gasLimit,
    gasPrice,
    nonce,
  });
}

// ─── Identity reads ───────────────────────────────────────────────────────────

/** Returns tokenId for a wallet address (0 = not registered). */
export async function identityGetTokenId(
  wallet: string,
  identityAddress: string,
  rpcUrl: string,
): Promise<number> {
  const calldata = encodeFunctionData({
    abi: [{ name: 'agentTokenId', type: 'function', inputs: [{ name: 'wallet', type: 'address' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'agentTokenId',
    args: [wallet as Hex],
  });
  try {
    const data = await rpc(rpcUrl, 'eth_call', [{ to: identityAddress, data: calldata }, 'latest']);
    if (!data || data === '0x') return 0;
    const [tokenId] = decodeAbiParameters(parseAbiParameters('uint256'), data as Hex);
    return Number(tokenId);
  } catch {
    return 0;
  }
}

export interface AgentRegistrationOnChain {
  name:         string;
  description:  string;
  mcpEndpoint:  string;
  tags:         string[];
  registeredAt: number;
  updatedAt:    number;
}

/** Returns the AgentRegistration for a tokenId, or null on any error. */
export async function identityGetRegistration(
  tokenId: number,
  identityAddress: string,
  rpcUrl: string,
): Promise<AgentRegistrationOnChain | null> {
  const calldata = encodeFunctionData({
    abi: [{
      name: 'getRegistration', type: 'function',
      inputs:  [{ name: 'tokenId', type: 'uint256' }],
      outputs: [{
        type: 'tuple',
        components: [
          { name: 'name',         type: 'string'   },
          { name: 'description',  type: 'string'   },
          { name: 'mcpEndpoint',  type: 'string'   },
          { name: 'tags',         type: 'string[]' },
          { name: 'registeredAt', type: 'uint256'  },
          { name: 'updatedAt',    type: 'uint256'  },
        ],
      }],
    }],
    functionName: 'getRegistration',
    args: [BigInt(tokenId)],
  });
  try {
    const data = await rpc(rpcUrl, 'eth_call', [{ to: identityAddress, data: calldata }, 'latest']);
    if (!data || data === '0x') return null;
    const decoded = decodeAbiParameters(
      parseAbiParameters('(string name, string description, string mcpEndpoint, string[] tags, uint256 registeredAt, uint256 updatedAt)'),
      data as Hex,
    );
    const r = decoded[0] as any;
    return {
      name:         r.name,
      description:  r.description,
      mcpEndpoint:  r.mcpEndpoint,
      tags:         [...(r.tags as string[])],
      registeredAt: Number(r.registeredAt),
      updatedAt:    Number(r.updatedAt),
    };
  } catch {
    return null;
  }
}

// ─── Reputation reads ─────────────────────────────────────────────────────────

/** Returns the aggregated reputation score for a tokenId. */
export async function repGetScore(
  tokenId: number,
  repAddress: string,
  rpcUrl: string,
): Promise<{ score: bigint; count: number }> {
  const calldata = encodeFunctionData({
    abi: [{
      name: 'getScore', type: 'function',
      inputs:  [{ name: 'tokenId', type: 'uint256' }],
      outputs: [{ name: 'score', type: 'int256' }, { name: 'count', type: 'uint256' }],
    }],
    functionName: 'getScore',
    args: [BigInt(tokenId)],
  });
  try {
    const data = await rpc(rpcUrl, 'eth_call', [{ to: repAddress, data: calldata }, 'latest']);
    if (!data || data === '0x') return { score: 0n, count: 0 };
    const [score, count] = decodeAbiParameters(parseAbiParameters('int256 score, uint256 count'), data as Hex);
    return { score: score as bigint, count: Number(count) };
  } catch {
    return { score: 0n, count: 0 };
  }
}

// ─── Identity writes ──────────────────────────────────────────────────────────

export function encodeIdentityRegister(
  name: string,
  description: string,
  mcpEndpoint: string,
  tags: string[],
): Hex {
  return encodeFunctionData({
    abi: [{
      name: 'register', type: 'function',
      inputs: [
        { name: '_name',        type: 'string'   },
        { name: '_description', type: 'string'   },
        { name: '_mcpEndpoint', type: 'string'   },
        { name: '_tags',        type: 'string[]' },
      ],
      outputs: [{ type: 'uint256' }],
    }],
    functionName: 'register',
    args: [name, description, mcpEndpoint, tags],
  });
}

/** Register an agent identity on-chain. Returns txHash. */
export async function identityRegister(
  env: Env,
  name: string,
  description: string,
  mcpEndpoint: string,
  tags: string[],
): Promise<Hex> {
  if (!env.AGENT_IDENTITY_ADDRESS) throw new Error('AGENT_IDENTITY_ADDRESS not configured.');
  const calldata = encodeIdentityRegister(name, description, mcpEndpoint, tags);
  return contractWrite(env, env.AGENT_IDENTITY_ADDRESS, calldata);
}

// ─── Reputation writes ────────────────────────────────────────────────────────

export function encodeRepSubmitFeedback(
  tokenId: number,
  value: bigint,
  decimals: number,
  tags: string[],
  evidenceUri: string,
): Hex {
  return encodeFunctionData({
    abi: [{
      name: 'submitFeedback', type: 'function',
      inputs: [
        { name: 'tokenId',     type: 'uint256'  },
        { name: 'value',       type: 'int128'   },
        { name: 'decimals',    type: 'uint8'    },
        { name: 'tags',        type: 'string[]' },
        { name: 'evidenceUri', type: 'string'   },
      ],
      outputs: [],
    }],
    functionName: 'submitFeedback',
    args: [BigInt(tokenId), value, decimals, tags, evidenceUri],
  });
}

/**
 * Submit feedback on-chain for an agent tokenId.
 * Fire-and-forget safe — callers should .catch(() => {}) if non-fatal.
 */
export async function repSubmitFeedback(
  env: Env,
  tokenId: number,
  value: bigint,
  tags: string[],
  evidenceUri: string,
): Promise<Hex> {
  if (!env.AGENT_REPUTATION_ADDRESS) throw new Error('AGENT_REPUTATION_ADDRESS not configured.');
  const calldata = encodeRepSubmitFeedback(tokenId, value, 18, tags, evidenceUri);
  return contractWrite(env, env.AGENT_REPUTATION_ADDRESS, calldata, 200_000n);
}

// ─── Receipt parsing ──────────────────────────────────────────────────────────

/**
 * Parse the minted tokenId from a HyberAgentIdentity.register() transaction receipt.
 * Looks for Transfer(address(0), to, tokenId) — Transfer has 3 indexed params so topics[3] = tokenId.
 */
export async function getTokenIdFromReceipt(
  rpcUrl: string,
  txHash: string,
  identityAddress: string,
): Promise<number | null> {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1_000));
    const receipt = await rpc(rpcUrl, 'eth_getTransactionReceipt', [txHash]) as any;
    if (!receipt) continue;

    const logs: any[] = receipt.logs ?? [];
    for (const log of logs) {
      if (log.address?.toLowerCase() !== identityAddress.toLowerCase()) continue;
      // Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
      // topics: [sig, from, to, tokenId]
      if (log.topics?.length >= 4) {
        return parseInt(log.topics[3], 16);
      }
    }
    return null;
  }
  return null;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

/** Format a reputation score (int256, 18 decimals) as a human-readable string. */
export function formatRepScore(score: bigint, count: number): string {
  const s = Number(score) / 1e18;
  return `${s >= 0 ? '+' : ''}${s.toFixed(4)}  (${count} feedback${count !== 1 ? 's' : ''})`;
}
