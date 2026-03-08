// AliasResolver interface and implementations for resolving human-readable names
// to HyberText transaction hashes.
//
// Supported resolvers (in priority order):
//   1. HyberRegistryResolver — HyberRegistry contract on Berachain
//   2. ENSResolver — ENS text records (stub, TODO)
//   3. BeranamesResolver — Beranames (ENS fork on Berachain, stub, TODO)

export interface AliasResolver {
  resolve(name: string): Promise<`0x${string}` | null>;
}

// Reads from the on-chain HyberRegistry contract via raw eth_call.
export class HyberRegistryResolver implements AliasResolver {
  constructor(
    private readonly rpcUrl: string,
    private readonly registryAddress: `0x${string}`,
  ) {}

  async resolve(name: string): Promise<`0x${string}` | null> {
    if (!name || this.registryAddress === '0x0000000000000000000000000000000000000000') return null;

    // ABI-encode resolve(string) call
    const data = encodeResolveCall(name);

    const res = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to: this.registryAddress, data }, 'latest'],
        id: 1,
      }),
    });
    if (!res.ok) return null;

    const json = await res.json() as { result?: string; error?: { message: string } };
    if (json.error || !json.result) return null;

    // Result is a bytes32 (32 bytes = 64 hex chars, prefixed with 0x)
    const hex = json.result.replace(/^0x/, '');
    if (hex === '0'.repeat(64)) return null; // zero hash = not registered

    return `0x${hex}` as `0x${string}`;
  }
}

// ENS resolver — reads the "hybertext" text record for a .eth name.
// Stub: returns null until ENS resolution is fully implemented.
export class ENSResolver implements AliasResolver {
  constructor(private readonly rpcUrl: string) {}

  async resolve(_name: string): Promise<`0x${string}` | null> {
    // TODO: query ENS public resolver for text record "hybertext"
    // on the name `${_name}.eth` (or similar convention)
    return null;
  }
}

// Beranames resolver — ENS fork deployed on Berachain.
// Stub: returns null until Beranames SDK/address is finalised.
export class BeranamesResolver implements AliasResolver {
  constructor(private readonly rpcUrl: string) {}

  async resolve(_name: string): Promise<`0x${string}` | null> {
    // TODO: query Beranames registry on Berachain for the name
    return null;
  }
}

// Tries each resolver in order, returns the first non-null result.
export class CompositeResolver implements AliasResolver {
  constructor(private readonly resolvers: AliasResolver[]) {}

  async resolve(name: string): Promise<`0x${string}` | null> {
    for (const r of this.resolvers) {
      const result = await r.resolve(name);
      if (result) return result;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// ABI helpers
// ---------------------------------------------------------------------------

// Manually ABI-encode a resolve(string) call without pulling in a full ABI library.
// Function selector for resolve(string): keccak256("resolve(string)") first 4 bytes.
// Selector verified: cast sig "resolve(string)" → 0x461a4478
function encodeResolveCall(name: string): string {
  const SELECTOR = '461a4478'; // keccak256("resolve(string)")[0:4]
  const nameBytes = Buffer.from(name, 'utf8');

  // ABI encoding for a single `string` argument:
  //   32 bytes: offset to string data (= 0x20 = 32)
  //   32 bytes: string length
  //   N bytes: string data, padded to 32-byte boundary
  const namePaddedLen = Math.ceil(nameBytes.length / 32) * 32;
  const buf = Buffer.alloc(4 + 32 + 32 + namePaddedLen);

  // Selector
  Buffer.from(SELECTOR, 'hex').copy(buf, 0);

  // Offset = 32
  buf[4 + 31] = 0x20;

  // String length
  buf.writeUInt32BE(nameBytes.length, 4 + 32 + 28);

  // String bytes
  nameBytes.copy(buf, 4 + 32 + 32);

  return '0x' + buf.toString('hex');
}
