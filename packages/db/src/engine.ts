import { decodeDbPayload } from './format';
import type { DbPatch, DbOp, JsonValue } from './types';

// ---------------------------------------------------------------------------
// RPC helper (raw fetch — avoids viem batching issues)
// ---------------------------------------------------------------------------

export async function fetchTxPayload(txHash: string, rpcUrl: string): Promise<Buffer> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1,
    }),
  });
  if (!res.ok) throw new Error(`RPC request failed: HTTP ${res.status}`);
  const json = await res.json() as { result?: { input: string } | null; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  if (!json.result) throw new Error(`Transaction not found: ${txHash}`);
  const hex = json.result.input.startsWith('0x') ? json.result.input.slice(2) : json.result.input;
  return Buffer.from(hex, 'hex');
}

// ---------------------------------------------------------------------------
// Apply operations to a state object
// ---------------------------------------------------------------------------

export function applyOps(
  data: Record<string, JsonValue>,
  ops: DbOp[],
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = { ...data };
  for (const op of ops) {
    if (op.op === 'SET')   { out[op.key] = op.val; }
    if (op.op === 'DEL')   { delete out[op.key]; }
    if (op.op === 'MERGE') { out[op.key] = { ...(out[op.key] as Record<string, JsonValue> ?? {}), ...op.val }; }
  }
  return out;
}

// ---------------------------------------------------------------------------
// State reconstruction engine
// ---------------------------------------------------------------------------

const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * Walks the patch chain from `head` backwards, reconstructing state.
 *
 * Walk order:   head → prev → prev → ... → snapshot (or genesis)
 * Apply order:  genesis → ... → prev → head  (oldest to newest)
 *
 * The in-memory cache avoids re-fetching the same tx twice.
 * Cache is keyed by txHash so it's safe across namespaces.
 */
export class StateEngine {
  private readonly stateCache = new Map<string, Record<string, JsonValue>>();

  async getState(
    head: string | null,
    rpcUrl: string,
  ): Promise<Record<string, JsonValue>> {
    if (!head || head === ZERO_HASH) return {};
    if (this.stateCache.has(head)) return this.stateCache.get(head)!;

    const patches: DbPatch[] = [];
    let cursor: string | null = head;

    while (cursor && cursor !== ZERO_HASH) {
      // Reuse cached intermediate state if available
      if (this.stateCache.has(cursor)) {
        const base  = this.stateCache.get(cursor)!;
        const state = this._applyPatches(base, patches);
        this.stateCache.set(head, state);
        return state;
      }

      const payload = await fetchTxPayload(cursor, rpcUrl);
      let decoded;
      try {
        decoded = decodeDbPayload(payload);
      } catch {
        break; // not a DB payload — treat as genesis (empty state)
      }

      if (decoded.type === 'snapshot') {
        // Cache the snapshot state itself, then apply pending patches
        this.stateCache.set(cursor, decoded.snapshot.data);
        const state = this._applyPatches(decoded.snapshot.data, patches);
        this.stateCache.set(head, state);
        return state;
      }

      if (decoded.type === 'patch') {
        patches.push(decoded.patch);
        cursor = decoded.patch.prev ?? null;
      } else {
        break;
      }
    }

    // Reached genesis (no snapshot) — apply all patches from empty state
    const state = this._applyPatches({}, patches);
    this.stateCache.set(head, state);
    return state;
  }

  /** Force a cache entry (e.g. after taking a snapshot). */
  prime(head: string, data: Record<string, JsonValue>): void {
    this.stateCache.set(head, data);
  }

  /** Remove cached entry for a head (e.g. after an invalidation). */
  evict(head: string): void {
    this.stateCache.delete(head);
  }

  // patches arrived newest-first; apply oldest-first
  private _applyPatches(
    base: Record<string, JsonValue>,
    patches: DbPatch[],
  ): Record<string, JsonValue> {
    let state = base;
    for (const patch of [...patches].reverse()) {
      state = applyOps(state, patch.ops);
    }
    return state;
  }
}
