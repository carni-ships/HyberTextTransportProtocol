import { createWalletClient, createPublicClient, http, defineChain, encodeFunctionData, decodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Chain + contract
// ---------------------------------------------------------------------------

const REGISTRY_ABI = [
  {
    name: 'register',
    type: 'function',
    inputs: [
      { name: 'name',   type: 'string'  },
      { name: 'txHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'update',
    type: 'function',
    inputs: [
      { name: 'name',   type: 'string'  },
      { name: 'txHash', type: 'bytes32' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'resolve',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    name: 'getRecord',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'txHash',    type: 'bytes32' },
          { name: 'owner',     type: 'address' },
          { name: 'updatedAt', type: 'uint64'  },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

// Default address — overridden via REGISTRY_ADDRESS env var.
// Set this to the deployed HyberRegistry address once deployed.
const DEFAULT_REGISTRY = '0x0000000000000000000000000000000000000000' as const;

function makeChain(rpcUrl: string) {
  return defineChain({
    id: 80094,
    name: 'Berachain',
    nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
    blockExplorers: { default: { name: 'Berascan', url: 'https://berascan.com' } },
  });
}

export interface AliasOptions {
  rpcUrl: string;
  privateKey: `0x${string}`;
  registryAddress?: `0x${string}`;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function resolveAlias(
  name: string,
  rpcUrl: string,
  registryAddress?: `0x${string}`,
): Promise<`0x${string}` | null> {
  const addr = registryAddress ?? (process.env.REGISTRY_ADDRESS as `0x${string}` | undefined) ?? DEFAULT_REGISTRY;
  if (addr === DEFAULT_REGISTRY) throw new Error('REGISTRY_ADDRESS not configured — set it via env or --registry flag');

  const chain  = makeChain(rpcUrl);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const result = await client.readContract({
    address: addr,
    abi: REGISTRY_ABI,
    functionName: 'resolve',
    args: [name],
  });

  const hex = (result as `0x${string}`).replace(/^0x/, '');
  if (hex === '0'.repeat(64)) return null;
  return `0x${hex}` as `0x${string}`;
}

export interface AliasRecord {
  txHash: `0x${string}`;
  owner: `0x${string}`;
  updatedAt: bigint;
}

export async function getAliasRecord(
  name: string,
  rpcUrl: string,
  registryAddress?: `0x${string}`,
): Promise<AliasRecord | null> {
  const addr = registryAddress ?? (process.env.REGISTRY_ADDRESS as `0x${string}` | undefined) ?? DEFAULT_REGISTRY;
  if (addr === DEFAULT_REGISTRY) throw new Error('REGISTRY_ADDRESS not configured');

  const chain  = makeChain(rpcUrl);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const result = await client.readContract({
    address: addr,
    abi: REGISTRY_ABI,
    functionName: 'getRecord',
    args: [name],
  }) as { txHash: `0x${string}`; owner: `0x${string}`; updatedAt: bigint };

  if (result.owner === '0x0000000000000000000000000000000000000000') return null;
  return result as AliasRecord;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export type AliasAction = 'register' | 'update' | 'auto';

/**
 * Register or update a HyberRegistry alias.
 * - 'register': always call register() — fails if name already taken
 * - 'update':   always call update() — fails if caller isn't owner
 * - 'auto':     call getRecord first; use register if unregistered, update otherwise
 */
export async function setAlias(
  name: string,
  siteTxHash: `0x${string}`,
  action: AliasAction,
  opts: AliasOptions,
): Promise<`0x${string}`> {
  const addr = opts.registryAddress ?? (process.env.REGISTRY_ADDRESS as `0x${string}` | undefined) ?? DEFAULT_REGISTRY;
  if (addr === DEFAULT_REGISTRY) throw new Error('REGISTRY_ADDRESS not configured — set it via env or --registry flag');

  const chain   = makeChain(opts.rpcUrl);
  const account = privateKeyToAccount(opts.privateKey);
  const wallet  = createWalletClient({ account, chain, transport: http(opts.rpcUrl) });
  const pub     = createPublicClient({ chain, transport: http(opts.rpcUrl) });

  // bytes32: pad tx hash to 32 bytes (tx hash is already 32 bytes = 64 hex)
  const hashBytes32 = siteTxHash as `0x${string}`;

  let fn: 'register' | 'update' = action === 'auto' ? 'register' : action;

  if (action === 'auto') {
    const existing = await getAliasRecord(name, opts.rpcUrl, addr);
    fn = existing ? 'update' : 'register';
  }

  const hash = await wallet.writeContract({
    address: addr,
    abi: REGISTRY_ABI,
    functionName: fn,
    args: [name, hashBytes32],
  });

  await pub.waitForTransactionReceipt({ hash });
  return hash;
}
