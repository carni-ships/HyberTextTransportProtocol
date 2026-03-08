import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { StateEngine, fetchTxPayload, applyOps } from './engine';
import { encodePatch, encodeSnapshot, decodeDbPayload } from './format';
import type {
  JsonValue, DbOp, DbPatch, DbSnapshot,
  QueryOptions, QueryResult, NamespaceInfo,
  DbClientOptions,
} from './types';

// ---------------------------------------------------------------------------
// Contract ABI (minimal)
// ---------------------------------------------------------------------------

const ABI = [
  {
    name: 'create',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }, { name: 'initialHead', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // commit(name, newHead) — basic, no hint
  {
    name: 'commit',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }, { name: 'newHead', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // commit(name, newHead, hint) — with index hint for off-chain indexers
  {
    name: 'commit',
    type: 'function',
    inputs: [
      { name: 'name',    type: 'string'  },
      { name: 'newHead', type: 'bytes32' },
      { name: 'hint',    type: 'bytes'   },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  // batchCommit — atomic multi-namespace commit
  {
    name: 'batchCommit',
    type: 'function',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'name',    type: 'string'  },
          { name: 'newHead', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
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
    name: 'getNamespace',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'head',      type: 'bytes32' },
          { name: 'owner',     type: 'address' },
          { name: 'schema',    type: 'bytes32' },
          { name: 'updatedAt', type: 'uint64'  },
          { name: 'hook',      type: 'address' },
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
    name: 'grantRole',
    type: 'function',
    inputs: [
      { name: 'name', type: 'string'  },
      { name: 'user', type: 'address' },
      { name: 'role', type: 'uint8'   },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    name: 'setHook',
    type: 'function',
    inputs: [{ name: 'name', type: 'string' }, { name: 'hook', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const SINK      = '0x000000000000000000000000000000000000dEaD' as const;
const ZERO_HASH = `0x${'0'.repeat(64)}` as `0x${string}`;

// ---------------------------------------------------------------------------
// Chain
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

// ---------------------------------------------------------------------------
// Raw eth_call helper (avoids viem transport batching)
// ---------------------------------------------------------------------------

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
  });
  if (!res.ok) throw new Error(`eth_call failed: HTTP ${res.status}`);
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(`eth_call error: ${json.error.message}`);
  return json.result ?? '0x';
}

// ---------------------------------------------------------------------------
// HyberDBClient
// ---------------------------------------------------------------------------

export class HyberDBClient {
  private readonly opts:   DbClientOptions;
  private readonly engine: StateEngine;

  constructor(opts: DbClientOptions) {
    this.opts   = opts;
    this.engine = new StateEngine();
  }

  // ── Namespace info ───────────────────────────────────────────────────────

  async info(ns: string): Promise<NamespaceInfo | null> {
    // ABI-encode getNamespace(string) call
    // Selector: cast sig "getNamespace(string)" = 0x73ceaebe
    const selector  = '73ceaebe';
    const nameBytes = Buffer.from(ns, 'utf8');
    const padLen    = Math.ceil(nameBytes.length / 32) * 32;
    const calldata  = Buffer.alloc(4 + 32 + 32 + padLen);
    Buffer.from(selector, 'hex').copy(calldata, 0);
    // offset to string data = 0x20 (32 bytes after the offset slot itself)
    calldata[4 + 31] = 0x20;
    // string length
    calldata.writeUInt32BE(nameBytes.length, 4 + 32 + 28);
    // string bytes
    nameBytes.copy(calldata, 4 + 32 + 32);

    const result = await ethCall(this.opts.rpcUrl, this.opts.contractAddress, '0x' + calldata.toString('hex'));
    if (!result || result === '0x') return null;

    const data = result.startsWith('0x') ? result.slice(2) : result;
    // Decode tuple: (bytes32 head, address owner, bytes32 schema, uint64 updatedAt, address hook)
    // Each field is padded to 32 bytes in ABI encoding
    const head      = '0x' + data.slice(0, 64);
    const owner     = '0x' + data.slice(64 + 24, 128);         // address: last 20 bytes of slot
    const schema    = '0x' + data.slice(128, 192);
    const updatedAt = parseInt(data.slice(192 + 48, 256), 16); // uint64: last 8 bytes of slot
    const hook      = '0x' + data.slice(256 + 24, 320);        // address: last 20 bytes of slot

    if (owner === '0x' + '0'.repeat(40)) return null; // not registered
    return {
      head,
      owner:     '0x' + owner.slice(2).toLowerCase(),
      schema,
      updatedAt,
      hook:      '0x' + hook.slice(2).toLowerCase(),
    };
  }

  // ── Read operations ──────────────────────────────────────────────────────

  async getAll(ns: string, opts?: QueryOptions): Promise<QueryResult> {
    const head = opts?.at ?? (await this.info(ns))?.head ?? null;
    const data = await this.engine.getState(head, this.opts.rpcUrl);

    let records = Object.entries(data).map(([key, val]) => ({ key, val }));

    // Filter
    if (opts?.where) {
      records = records.filter(({ val }) => {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) return false;
        return Object.entries(opts.where!).every(([k, v]) => (val as Record<string, JsonValue>)[k] === v);
      });
    }

    // Sort
    if (opts?.orderBy) {
      const field = opts.orderBy;
      const dir   = opts.orderDir === 'desc' ? -1 : 1;
      records.sort((a, b) => {
        const av = typeof a.val === 'object' && a.val !== null ? (a.val as Record<string, JsonValue>)[field] : a.val;
        const bv = typeof b.val === 'object' && b.val !== null ? (b.val as Record<string, JsonValue>)[field] : b.val;
        if (av == null && bv == null) return 0;
        if (av == null) return dir;
        if (bv == null) return -dir;
        return av < bv ? -dir : av > bv ? dir : 0;
      });
    }

    const total   = records.length;
    const offset  = opts?.offset ?? 0;
    const limited = opts?.limit ? records.slice(offset, offset + opts.limit) : records.slice(offset);

    return { records: limited, total };
  }

  async get(ns: string, key: string, opts?: Pick<QueryOptions, 'at'>): Promise<JsonValue | null> {
    const head = opts?.at ?? (await this.info(ns))?.head ?? null;
    const data = await this.engine.getState(head, this.opts.rpcUrl);
    return data[key] ?? null;
  }

  // ── Write operations ─────────────────────────────────────────────────────

  async set(ns: string, key: string, val: JsonValue): Promise<`0x${string}`> {
    return this._write(ns, [{ op: 'SET', key, val }]);
  }

  async del(ns: string, key: string): Promise<`0x${string}`> {
    return this._write(ns, [{ op: 'DEL', key }]);
  }

  async merge(ns: string, key: string, val: Record<string, JsonValue>): Promise<`0x${string}`> {
    return this._write(ns, [{ op: 'MERGE', key, val }]);
  }

  /** Batch multiple operations in a single transaction. */
  async batch(ns: string, ops: DbOp[]): Promise<`0x${string}`> {
    return this._write(ns, ops);
  }

  /**
   * Atomically commit multiple namespaces in one transaction (batchCommit).
   * The caller must have WRITER or OWNER on every namespace.
   * All commits succeed or all revert.
   */
  async batchWrite(calls: Array<{ ns: string; ops: DbOp[] }>): Promise<`0x${string}`[]> {
    if (this.opts.relayerUrl) throw new Error('batchWrite is not supported via relayer');
    if (!this.opts.privateKey) throw new Error('privateKey required for batchWrite');

    // Write each patch to calldata first, collect txHashes
    const patchTxHashes: Array<{ ns: string; head: `0x${string}`; prev: string | null }> = [];
    const ctx = await this._makeTxContext();

    for (const { ns, ops } of calls) {
      const nsInfo = await this.info(ns);
      const prev   = nsInfo?.head && nsInfo.head !== ZERO_HASH ? nsInfo.head : null;
      const patch: DbPatch = { v: 1, prev, ns, ops, ts: Date.now() };
      const payload = encodePatch(patch);
      const txHash  = await this._sendCalldataRaw(payload, ctx);
      patchTxHashes.push({ ns, head: txHash, prev });
    }

    // Wait for all patch txs to land before committing heads
    await Promise.all(patchTxHashes.map(({ head }) =>
      ctx.pub.waitForTransactionReceipt({ hash: head }),
    ));

    // Advance all heads atomically via batchCommit
    const batchTx = await ctx.wallet.writeContract({
      address:      this.opts.contractAddress,
      abi:          ABI,
      functionName: 'batchCommit',
      args:         [patchTxHashes.map(({ ns, head }) => ({ name: ns, newHead: head as `0x${string}` }))],
      nonce:        ctx.nonce++,
    });
    await ctx.pub.waitForTransactionReceipt({ hash: batchTx });

    return patchTxHashes.map(p => p.head);
  }

  /** Register a hook contract on a namespace (OWNER only). Pass zero address to disable. */
  async setHook(ns: string, hookAddress: `0x${string}`): Promise<`0x${string}`> {
    if (!this.opts.privateKey) throw new Error('privateKey required');
    const chain   = makeChain(this.opts.rpcUrl);
    const account = privateKeyToAccount(this.opts.privateKey);
    const wallet  = createWalletClient({ account, chain, transport: http(this.opts.rpcUrl) });
    const pub     = createPublicClient({ chain, transport: http(this.opts.rpcUrl), pollingInterval: 1_000 });
    const hash = await wallet.writeContract({
      address:      this.opts.contractAddress,
      abi:          ABI,
      functionName: 'setHook',
      args:         [ns, hookAddress],
    });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Compact the patch chain into a snapshot (reduces future read latency). */
  async snapshot(ns: string): Promise<`0x${string}`> {
    const nsInfo = await this.info(ns);
    if (!nsInfo || nsInfo.head === ZERO_HASH) throw new Error(`Namespace "${ns}" is empty`);

    const data = await this.engine.getState(nsInfo.head, this.opts.rpcUrl);
    const snap: DbSnapshot = { v: 1, head: nsInfo.head, ns, data, ts: Date.now() };
    const payload = encodeSnapshot(snap);

    const txHash = await this._sendCalldata(payload);
    // After writing the snapshot, advance the head to it
    await this._commitHead(ns, nsInfo.head, txHash);
    this.engine.prime(txHash, data);
    return txHash;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async _write(ns: string, ops: DbOp[]): Promise<`0x${string}`> {
    if (this.opts.relayerUrl) {
      return this._relayWrite(ns, ops);
    }

    const nsInfo = await this.info(ns);
    const prev   = nsInfo?.head && nsInfo.head !== ZERO_HASH ? nsInfo.head : null;

    const patch: DbPatch = { v: 1, prev, ns, ops, ts: Date.now() };
    const payload = encodePatch(patch);

    const txHash = await this._sendCalldata(payload);
    await this._commitHead(ns, prev, txHash);
    return txHash;
  }

  /** Build a nonce-tracking tx context for multi-tx sequences. */
  private async _makeTxContext(): Promise<{
    wallet: ReturnType<typeof createWalletClient>;
    pub:    ReturnType<typeof createPublicClient>;
    nonce:  number;
  }> {
    if (!this.opts.privateKey) throw new Error('privateKey required');
    const chain   = makeChain(this.opts.rpcUrl);
    const account = privateKeyToAccount(this.opts.privateKey);
    const wallet  = createWalletClient({ account, chain, transport: http(this.opts.rpcUrl) });
    const pub     = createPublicClient({ chain, transport: http(this.opts.rpcUrl), pollingInterval: 1_000 });
    const nonce   = await pub.getTransactionCount({ address: account.address });
    return { wallet, pub, nonce };
  }

  /** Send raw calldata using a shared tx context (explicit nonce, no waiting). */
  private async _sendCalldataRaw(
    data:  Buffer,
    ctx:   { wallet: ReturnType<typeof createWalletClient>; pub: ReturnType<typeof createPublicClient>; nonce: number },
  ): Promise<`0x${string}`> {
    const hash = await ctx.wallet.sendTransaction({
      to:    SINK,
      data:  `0x${data.toString('hex')}`,
      value: 0n,
      nonce: ctx.nonce++,
    });
    return hash;
  }

  /** Send raw calldata to the SINK address and return txHash. */
  private async _sendCalldata(data: Buffer): Promise<`0x${string}`> {
    if (!this.opts.privateKey) throw new Error('privateKey required for direct writes');
    const chain   = makeChain(this.opts.rpcUrl);
    const account = privateKeyToAccount(this.opts.privateKey);
    const wallet  = createWalletClient({ account, chain, transport: http(this.opts.rpcUrl) });
    const pub     = createPublicClient({ chain, transport: http(this.opts.rpcUrl), pollingInterval: 1_000 });

    const hash = await wallet.sendTransaction({
      to:    SINK,
      data:  `0x${data.toString('hex')}`,
      value: 0n,
    });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Call HyberDB.commit() or create() to advance the head pointer. */
  private async _commitHead(ns: string, prevHead: string | null, newHead: `0x${string}`): Promise<void> {
    if (!this.opts.privateKey) throw new Error('privateKey required for direct writes');
    const chain   = makeChain(this.opts.rpcUrl);
    const account = privateKeyToAccount(this.opts.privateKey);
    const wallet  = createWalletClient({ account, chain, transport: http(this.opts.rpcUrl) });
    const pub     = createPublicClient({ chain, transport: http(this.opts.rpcUrl), pollingInterval: 1_000 });

    // Use create() only when there is no prior head AND the namespace is not yet registered
    const existing = await this.info(ns);
    const functionName = (!prevHead || prevHead === ZERO_HASH) && !existing ? 'create' : 'commit';

    const hash = await wallet.writeContract({
      address:      this.opts.contractAddress,
      abi:          ABI,
      functionName,
      args:         [ns, newHead as `0x${string}`],
    });
    await pub.waitForTransactionReceipt({ hash });
  }

  /** Gasless: forward signed ops to the Worker relayer. */
  private async _relayWrite(ns: string, ops: DbOp[]): Promise<`0x${string}`> {
    if (!this.opts.privateKey) throw new Error('privateKey required for gasless writes (to sign)');
    if (!this.opts.relayerUrl) throw new Error('relayerUrl required for gasless writes');

    const account = privateKeyToAccount(this.opts.privateKey);
    const chain   = makeChain(this.opts.rpcUrl);
    const pub     = createPublicClient({ chain, transport: http(this.opts.rpcUrl), pollingInterval: 1_000 });

    // Get current nonce from contract
    const nonce = await pub.readContract({
      address:      this.opts.contractAddress,
      abi:          ABI,
      functionName: 'getNonce',
      args:         [ns, account.address],
    }) as bigint;

    // Sign the payload (ops + nonce) so the relayer can verify the request
    // Note: the relayer verifies this simple message sig before submitting on-chain.
    // The on-chain commitSigned uses a separate EIP-712 sig over the final txHash;
    // that path is only used for direct commitSigned calls (not the relay MVP).
    const sig = await account.signMessage({
      message: JSON.stringify({ ns, ops, nonce: Number(nonce) }),
    });

    const res = await fetch(`${this.opts.relayerUrl}/db/_relay`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ns, ops, signer: account.address, nonce: Number(nonce), sig }),
    });
    if (!res.ok) throw new Error(`Relay failed: ${res.status} ${await res.text()}`);
    const json = await res.json() as { txHash: string };
    return json.txHash as `0x${string}`;
  }

  // ── Polling subscription ─────────────────────────────────────────────────

  /**
   * Poll for changes to a namespace.
   * Returns an unsubscribe function.
   */
  subscribe(
    ns: string,
    cb: (ops: DbOp[], newHead: string) => void,
    intervalMs = 5000,
  ): () => void {
    let lastHead: string | null = null;
    let running = true;

    const poll = async () => {
      if (!running) return;
      try {
        const nsInfo = await this.info(ns);
        const head   = nsInfo?.head ?? null;
        if (head && head !== ZERO_HASH && head !== lastHead) {
          if (lastHead) {
            // Collect ops since lastHead (walk backwards from head until we hit lastHead)
            const ops: DbOp[] = [];
            let cursor: string | null = head;
            while (cursor && cursor !== lastHead && cursor !== ZERO_HASH) {
              const payload = await fetchTxPayload(cursor, this.opts.rpcUrl);
              const decoded = decodeDbPayload(payload);
              if (decoded.type === 'patch') {
                ops.unshift(...decoded.patch.ops); // prepend (oldest first)
                cursor = decoded.patch.prev ?? null;
              } else {
                break;
              }
            }
            cb(ops, head);
          }
          lastHead = head;
        }
      } catch {
        // Ignore transient errors
      }
      if (running) setTimeout(poll, intervalMs);
    };

    setTimeout(poll, 0);
    return () => { running = false; };
  }
}
