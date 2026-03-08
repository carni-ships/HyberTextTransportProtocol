/**
 * x402.ts — Berachain-native payment verification and session management.
 *
 * Payment flow:
 *   1. Client visits encrypted site → Worker returns 402 with X-Payment-* headers
 *   2. Client sends BERA tx to vault.beneficiary (= publisher) with siteTxHash as calldata
 *   3. Client retries with X-Payment-Tx: <txHash> and X-Payment-Payer: <address>
 *   4. Worker verifies tx on-chain, records grant, issues session cookie
 *   5. Subsequent requests use Cookie: hyber_session=<token>
 *
 * Replay prevention: two layers
 *   - Worker KV (fast, per-instance): key "used:{paymentTxHash}" → "1"
 *   - On-chain HyberKeyVault.isPaymentUsed() (authoritative, cross-instance)
 */

import type { VaultRecord } from './vault.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

// ---------------------------------------------------------------------------
// 402 response
// ---------------------------------------------------------------------------

export function make402Response(
  siteTxHash: string,
  vault: VaultRecord,
  origin: string,
): Response {
  const priceFormatted = formatBera(vault.priceWei);
  const body = JSON.stringify({
    scheme:         'hybertext-bera-v1',
    siteTxHash,
    priceWei:       vault.priceWei.toString(),
    priceFormatted: `${priceFormatted} BERA`,
    recipient:      vault.publisher,
    keyDuration:    vault.keyDuration,
    chainId:        80094,
    instructions:   `Send ${priceFormatted} BERA to ${vault.publisher} with siteTxHash (${siteTxHash}) as calldata (tx.data), then retry with X-Payment-Tx: <txHash> and X-Payment-Payer: <yourAddress> headers.`,
    gatewayUrl:     `${origin}/${siteTxHash}`,
  });

  const headers = {
    'Content-Type':                'application/json',
    'X-Payment-Scheme':            'hybertext-bera-v1',
    'X-Payment-Site':              siteTxHash,
    'X-Payment-Amount-Wei':        vault.priceWei.toString(),
    'X-Payment-Amount':            priceFormatted,
    'X-Payment-Recipient':         vault.publisher,
    'X-Payment-Key-Duration':      vault.keyDuration.toString(),
    'X-Payment-Chain-Id':          '80094',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': [
      'X-Payment-Scheme', 'X-Payment-Site', 'X-Payment-Amount-Wei',
      'X-Payment-Amount', 'X-Payment-Recipient', 'X-Payment-Key-Duration',
      'X-Payment-Chain-Id',
    ].join(', '),
  };

  return new Response(body, { status: 402, headers });
}

// ---------------------------------------------------------------------------
// Payment verification
// ---------------------------------------------------------------------------

export interface PaymentVerifyResult {
  valid:   boolean;
  error?:  string;
}

export async function verifyPayment(
  siteTxHash:     string,
  paymentTxHash:  string,
  payerAddress:   string,
  vault:          VaultRecord,
  rpcUrl:         string,
  usedKV?:        KVNamespace,
  vaultAddress?:  string,
): Promise<PaymentVerifyResult> {
  const fail = (error: string): PaymentVerifyResult => ({ valid: false, error });

  // 1. Fast KV replay check
  if (usedKV) {
    const used = await usedKV.get(`used:${paymentTxHash.toLowerCase()}`);
    if (used) return fail('Payment already used (KV)');
  }

  // 2. Fetch payment tx
  let tx: TxResult;
  try {
    tx = await fetchTx(paymentTxHash, rpcUrl);
  } catch (e: any) {
    return fail(`Payment tx fetch failed: ${e.message}`);
  }
  if (!tx) return fail('Payment tx not found');

  // 3. Tx must be confirmed (blockNumber present)
  if (!tx.blockNumber) return fail('Payment tx not yet confirmed');

  // 4. Recipient must match vault publisher
  if ((tx.to ?? '').toLowerCase() !== vault.publisher.toLowerCase()) {
    return fail(`Wrong recipient: expected ${vault.publisher}, got ${tx.to}`);
  }

  // 5. Value must be >= priceWei (skip if price is 0)
  if (vault.priceWei > 0n) {
    const paid = BigInt(tx.value ?? '0x0');
    if (paid < vault.priceWei) {
      return fail(`Insufficient payment: need ${vault.priceWei} wei, got ${paid}`);
    }
  }

  // 6. calldata must be the siteTxHash (32 bytes)
  const expectedData = siteTxHash.startsWith('0x') ? siteTxHash.toLowerCase() : `0x${siteTxHash}`.toLowerCase();
  if ((tx.input ?? '0x').toLowerCase() !== expectedData) {
    return fail('Payment calldata does not match siteTxHash');
  }

  // 7. Sender must match claimed payer
  if ((tx.from ?? '').toLowerCase() !== payerAddress.toLowerCase()) {
    return fail(`Tx sender ${tx.from} does not match claimed payer ${payerAddress}`);
  }

  // 8. Fetch receipt to confirm success
  let receipt: TxReceipt;
  try {
    receipt = await fetchReceipt(paymentTxHash, rpcUrl);
  } catch (e: any) {
    return fail(`Receipt fetch failed: ${e.message}`);
  }
  if (!receipt || receipt.status !== '0x1') return fail('Payment tx failed (status != 1)');

  // 9. On-chain replay check
  if (vaultAddress) {
    try {
      const used = await isPaymentUsedOnChain(paymentTxHash, vaultAddress, rpcUrl);
      if (used) return fail('Payment already used (on-chain)');
    } catch {
      // Non-fatal — KV check already covers most cases
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

export async function issueSession(
  siteTxHash:  string,
  payerAddress: string,
  vault:        VaultRecord,
  sessionsKV:   KVNamespace,
  usedKV:       KVNamespace,
  paymentTxHash: string,
): Promise<{ token: string; expiresAt: number; cookieMaxAge: number }> {
  const token     = crypto.randomUUID();
  const now       = Math.floor(Date.now() / 1000);
  const expiresAt = vault.keyDuration > 0 ? now + vault.keyDuration : 0;

  // KV TTL: keyDuration if set, else 30 days
  const ttl = vault.keyDuration > 0 ? vault.keyDuration : 60 * 60 * 24 * 30;

  await sessionsKV.put(
    `session:${token}`,
    JSON.stringify({ siteTxHash, payer: payerAddress, expiresAt, grantedAt: now }),
    { expirationTtl: ttl },
  );

  // Mark payment as used in KV (authoritative mark is on-chain via grantAccess)
  await usedKV.put(`used:${paymentTxHash.toLowerCase()}`, '1', { expirationTtl: 60 * 60 * 24 * 365 });

  const cookieMaxAge = vault.keyDuration > 0 ? vault.keyDuration : 60 * 60 * 24 * 30;
  return { token, expiresAt, cookieMaxAge };
}

export async function checkSession(
  token:      string,
  siteTxHash: string,
  sessionsKV: KVNamespace,
): Promise<{ valid: boolean; payer?: string }> {
  const raw = await sessionsKV.get(`session:${token}`);
  if (!raw) return { valid: false };

  let session: { siteTxHash: string; payer: string; expiresAt: number };
  try { session = JSON.parse(raw); } catch { return { valid: false }; }

  if (session.siteTxHash !== siteTxHash)                             return { valid: false };
  if (session.expiresAt > 0 && session.expiresAt < Date.now() / 1000) return { valid: false };

  return { valid: true, payer: session.payer };
}

/** Parse hyber_session cookie value from Cookie header. */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)hyber_session=([^;]+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// On-chain replay check
// ---------------------------------------------------------------------------

// Selector: cast sig "isPaymentUsed(bytes32)" = 0x0adc6bce
const IS_PAYMENT_USED_SELECTOR = '0adc6bce';

async function isPaymentUsedOnChain(
  paymentTxHash: string,
  vaultAddress:  string,
  rpcUrl:        string,
): Promise<boolean> {
  const hash32   = paymentTxHash.startsWith('0x') ? paymentTxHash.slice(2) : paymentTxHash;
  const calldata = '0x' + IS_PAYMENT_USED_SELECTOR + hash32.padStart(64, '0');

  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      jsonrpc: '2.0', method: 'eth_call',
      params: [{ to: vaultAddress, data: calldata }, 'latest'], id: 1,
    }),
  });
  if (!res.ok) throw new Error(`RPC failed: ${res.status}`);
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  // Returns bool: last byte of the 32-byte result is 1 if true
  return (json.result ?? '0x').endsWith('1');
}

// ---------------------------------------------------------------------------
// RPC helpers
// ---------------------------------------------------------------------------

interface TxResult {
  from?:        string;
  to?:          string;
  value?:       string;
  input?:       string;
  blockNumber?: string | null;
}

interface TxReceipt {
  status?: string;
}

async function fetchTx(txHash: string, rpcUrl: string): Promise<TxResult> {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { result?: TxResult | null; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (!json.result) throw new Error('Transaction not found');
  return json.result;
}

async function fetchReceipt(txHash: string, rpcUrl: string): Promise<TxReceipt> {
  const res = await fetch(rpcUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionReceipt', params: [txHash], id: 1 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json() as { result?: TxReceipt | null; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  if (!json.result) throw new Error('Receipt not found');
  return json.result;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function formatBera(wei: bigint): string {
  const bera = Number(wei) / 1e18;
  return bera.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
