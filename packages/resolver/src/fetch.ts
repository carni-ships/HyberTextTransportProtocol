import { createPublicClient, http, defineChain } from 'viem';

const RPC_URL = process.env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

const berachain = defineChain({
  id: 80094,
  name: 'Berachain',
  nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Berascan', url: 'https://berascan.com' } },
});

// Single shared client — viem handles connection pooling internally
const client = createPublicClient({ chain: berachain, transport: http(RPC_URL) });

export async function fetchTxInput(txHash: `0x${string}`): Promise<Buffer> {
  const tx = await client.getTransaction({ hash: txHash });
  if (!tx) throw new Error(`Transaction not found: ${txHash}`);
  const hex = tx.input.startsWith('0x') ? tx.input.slice(2) : tx.input;
  return Buffer.from(hex, 'hex');
}
