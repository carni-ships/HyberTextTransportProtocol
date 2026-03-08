// ---------------------------------------------------------------------------
// JSON value type
// ---------------------------------------------------------------------------

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// ---------------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------------

export type DbOp =
  | { op: 'SET';   key: string; val: JsonValue }
  | { op: 'DEL';   key: string }
  | { op: 'MERGE'; key: string; val: Record<string, JsonValue> };

// ---------------------------------------------------------------------------
// HYTE payload types
// ---------------------------------------------------------------------------

/** DB_PATCH (contentType=5): incremental write operations */
export interface DbPatch {
  v:    1;
  prev: string | null; // previous head txHash (null = genesis / first patch)
  ns:   string;
  ops:  DbOp[];
  ts?:  number;        // client-side timestamp (ms since epoch)
}

/** DB_SNAPSHOT (contentType=6): full state at a point in time */
export interface DbSnapshot {
  v:    1;
  head: string;                    // head txHash this snapshot was taken at
  ns:   string;
  data: Record<string, JsonValue>; // complete current state
  ts?:  number;
}

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export interface NamespaceInfo {
  head:      string; // 0x-prefixed bytes32 (zero = empty)
  owner:     string; // checksummed address
  schema:    string; // 0x-prefixed bytes32 (zero = no schema)
  updatedAt: number; // unix timestamp (seconds)
  hook:      string; // IHyberHook contract address (zero = none)
}

export enum Role { NONE = 0, READER = 1, WRITER = 2, OWNER = 3 }

// ---------------------------------------------------------------------------
// Client types
// ---------------------------------------------------------------------------

export interface QueryOptions {
  where?:    Record<string, JsonValue>; // field equality filters
  orderBy?:  string;
  orderDir?: 'asc' | 'desc';
  limit?:    number;
  offset?:   number;
  at?:       string; // time-travel: use this txHash as head instead of current
}

export interface QueryResult {
  records: Array<{ key: string; val: JsonValue }>;
  total:   number;
}

export interface DbClientOptions {
  rpcUrl:           string;
  contractAddress:  `0x${string}`;
  privateKey?:      `0x${string}`;  // for direct on-chain writes (CLI)
  relayerUrl?:      string;         // for gasless writes via Worker
}

// ---------------------------------------------------------------------------
// Relayer types
// ---------------------------------------------------------------------------

export interface RelayRequest {
  ns:     string;
  ops:    DbOp[];
  signer: `0x${string}`;
  nonce:  number;
  sig:    `0x${string}`; // EIP-712 signature
}

export interface RelayEnv {
  rpcUrl:          string;
  contractAddress: `0x${string}`;
  privateKey:      `0x${string}`; // relayer wallet pays gas
}
