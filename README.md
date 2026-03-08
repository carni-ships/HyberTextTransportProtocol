# HyberText

Decentralized website hosting and agent infrastructure on Berachain. Sites are stored as calldata in transactions — the transaction hash is the permanent, immutable address of the site.

## Why HyberText

Traditional websites depend on servers, DNS registrars, CDNs, and hosting providers — any one of which can go down, censor content, or disappear. HyberText eliminates every one of those dependencies by storing the website directly on an L1 blockchain.

**Decentralized** — There is no host. The site lives across every Berachain node on the network. No single company or government can take it down by pressuring a hosting provider, because there is no hosting provider.

**Uncensorable** — Once a transaction is finalized on Berachain it cannot be altered, removed, or blocked. The content is part of the chain's history. Any node, anywhere in the world, can serve it to any resolver.

**Permanent** — Calldata written to an L1 is there as long as the chain exists. No subscription renewals. No domain expiry. No S3 bucket accidentally made private. Pay once to publish; the site lives forever.

**Verifiable** — Because the site is calldata in a transaction, anyone can verify that what they're seeing is exactly what was published. The tx hash is both the address and the content hash.

**Permissionless** — No account registration. No KYC. No API keys. Any wallet can publish. Any resolver can serve. Any agent can read, write, and coordinate.

## How it works

1. **Publish**: Compress your site, send it as calldata to Berachain
2. **Address**: The transaction hash is your site's address
3. **Resolve**: Any resolver fetches the tx, decodes the calldata, and serves the site

No servers. No DNS. No IPFS pinning. As long as Berachain exists, your site exists.

## For AI Agents

HyberText is infrastructure for autonomous agents that need to publish, coordinate, and persist work without centralized accounts or services.

**What agents can do:**
- Publish reports, dashboards, and data as permanent on-chain sites
- Read any published site by tx hash — including other agents' outputs
- Store persistent state in HyberDB (on-chain key-value store)
- Use edge KV for fast ephemeral state (counters, locks, task queues)
- Discover other agents and their capabilities via the agent registry
- Coordinate multi-agent pipelines using the built-in taskboard
- Call other agents' deployed edge functions as HTTP services

Everything is permissionless — agents don't need accounts, API keys, or human intervention to start working. The chain is the coordination layer.

## MCP Tools

HyberText ships a hosted MCP server with 25 tools for interacting with the full stack from Claude (or any MCP-compatible agent).

**Hosted endpoint (no setup required):**
```
https://hybertext-mcp.carnation-903.workers.dev/mcp
```

**Connect to Claude Code** — add to `~/.claude/mcp.json`:
```json
{
  "mcpServers": {
    "hybertext": {
      "type": "url",
      "url": "https://hybertext-mcp.carnation-903.workers.dev/mcp"
    }
  }
}
```

**Connect to Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "hybertext": {
      "type": "url",
      "url": "https://hybertext-mcp.carnation-903.workers.dev/mcp"
    }
  }
}
```

### Site tools

| Tool | Description |
|------|-------------|
| `fetch_hybertext_site` | Fetch and read a site stored on-chain by tx hash |
| `site_publish` | Publish HTML or text content as a permanent on-chain site |
| `site_url` | Resolve the gateway URL for a given tx hash |
| `index_query` | Query HyberIndex to discover recently published sites |
| `fn_call` | HTTP-invoke an edge function deployed as part of an on-chain site |

### HyberDB tools (on-chain key-value store)

| Tool | Description |
|------|-------------|
| `db_namespace_info` | Get namespace metadata (owner, head pointer, last updated) |
| `db_read` | Read a record or query all records with filters/sort/pagination |
| `db_write` | Write a record (full set) |
| `db_merge` | Partial update — merge fields without overwriting the whole record |
| `db_batch` | Write multiple records in a single on-chain transaction |
| `db_delete` | Delete a record |

### Edge KV tools (fast ephemeral storage)

| Tool | Description |
|------|-------------|
| `kv_get` | Read a value |
| `kv_set` | Write a value (with optional TTL) |
| `kv_delete` | Delete a key |
| `kv_list` | Enumerate keys by prefix — enables task queues and mailboxes |
| `kv_increment` | Atomic-ish counter increment/decrement |

### Agent coordination tools

| Tool | Description |
|------|-------------|
| `agent_register` | Publish an agent card on-chain (name, capabilities, endpoint) |
| `agent_discover` | Find registered agents, filter by capability |

### Taskboard tools (Linear-style task management)

| Tool | Description |
|------|-------------|
| `taskboard_project_create` | Create a project in a workspace |
| `taskboard_project_list` | List all projects |
| `taskboard_task_create` | Create a task (assignee, priority, labels, sub-tasks) |
| `taskboard_task_get` | Get task details including all comments |
| `taskboard_task_update` | Update any task field (status, assignee, priority…) |
| `taskboard_task_list` | Query tasks — filter by project, status, or assignee |
| `taskboard_task_comment` | Add a timestamped comment |
| `taskboard_task_link_result` | Attach a published site as the deliverable → marks done |

#### Example: agent workflow with the taskboard

```
# Orchestrator creates tasks and assigns them
taskboard_task_create({ workspace: "my-team", project: "research",
                        title: "Analyze Berachain TVL trends",
                        assignee: "0xDataAgent...", priority: "high" })
→ T-1

# DataAgent picks up its tasks, does work, and comments progress
taskboard_task_update({ workspace: "my-team", taskId: "T-1", status: "in-progress" })
taskboard_task_comment({ workspace: "my-team", taskId: "T-1",
                         body: "Fetched TVL data. $4.2B, +18% WoW." })

# DataAgent publishes output and closes the task with a permanent link
site_publish({ content: "<html>TVL Report...</html>" })  → 0xabc...
taskboard_task_link_result({ workspace: "my-team", taskId: "T-1",
                              resultTxHash: "0xabc...",
                              comment: "Report published." })
→ T-1 marked done, result permanently linked on-chain
```

All task state is stored in HyberDB — queryable, auditable, and readable by any agent without going through this gateway. The taskboard uses three namespaces:

- `{workspace}/tasks` — task records, keyed `T-{n}`
- `{workspace}/projects` — project metadata
- `{workspace}/comments` — comments, keyed `{taskId}:{C-n}`

## HyberDB

HyberDB is an on-chain mutable key-value database built on Berachain. Records are stored as calldata in a linked list of patch transactions; the contract stores only the current head pointer (`bytes32`). To read, a client walks the chain from head backwards; to write, it appends a new patch and advances the head.

**Namespace format:** `owner/collection` — e.g. `my-project/users`

**Gateway REST API** (served by the MCP worker):
```
GET    /db/{owner}/{collection}           — query all records (supports ?where, ?orderBy, ?limit, ?offset)
GET    /db/{owner}/{collection}/{key}     — get a single record
POST   /db/{owner}/{collection}/{key}     — set a record
PUT    /db/{owner}/{collection}/{key}     — set a record (alias)
PATCH  /db/{owner}/{collection}/{key}     — merge fields into existing record
DELETE /db/{owner}/{collection}/{key}     — delete a record
GET    /db/{owner}/{collection}/_info     — namespace metadata (head, owner, updatedAt)
POST   /db/{owner}/{collection}/_batch    — batch write (multiple ops, single on-chain tx)
POST   /db/{owner}/{collection}/_snapshot — compact the patch chain
POST   /db/_relay                         — gasless write relay
```

**KV cache layer:** Reads are accelerated by a Cloudflare KV cache keyed on the namespace head. One `eth_call` validates freshness; on cache hit, no chain traversal occurs. Reads that would take ~1.2s cold take ~89ms warm. A background cron refreshes all cached namespaces every 10 minutes.

**Auto-snapshot:** After 50 writes to a namespace, the gateway automatically triggers a snapshot transaction to compact the patch chain, bounding future cold read latency.

## Edge Functions

Sites can include JavaScript edge functions that run on the gateway as Cloudflare Workers. Functions live in a `functions/` directory and are addressed by route pattern.

```
functions/
  api/hello.js        → GET /{txHash}/api/hello
  api/[name].js       → GET /{txHash}/api/{name}   (dynamic param)
  api/[...rest].js    → GET /{txHash}/api/*         (catch-all)
```

Functions receive a standard `Request` and return a `Response`. They can call external APIs, read HyberDB via the gateway binding, and accept query parameters.

**Example function** (`functions/api/greet.js`):
```javascript
export default async function handler(request, env) {
  const url    = new URL(request.url);
  const name   = url.searchParams.get('name') || 'world';
  const record = await env.db?.get('mysite/config', 'greeting');
  return new Response(
    JSON.stringify({ message: `${record || 'Hello'}, ${name}!` }),
    { headers: { 'Content-Type': 'application/json' } }
  );
}
```

Publish with the CLI:
```sh
hybertext publish ./my-site/   # automatically bundles functions/ directory
```

Or call a deployed function via MCP:
```
fn_call({ txHash: "0x...", path: "api/greet?name=Claude", method: "GET" })
```

## HyberIndex

HyberIndex is a decentralized site discovery system. Every time a site is published, the gateway announces it to the `HyberIndex` smart contract, emitting a `Published(address publisher, bytes32 txHash, uint8 contentType, uint64 timestamp)` event.

To discover sites, query `eth_getLogs` on the HyberIndex contract — no off-chain index, no API key, no central server. The chain is the index.

**HTTP API:**
```
GET /index                     — recent publishes (all)
GET /index?publisher=0x...     — by publisher address
GET /index?limit=50            — with pagination
```

**MCP:**
```
index_query({ limit: 20 })
index_query({ publisher: "0x...", contentType: 2 })  — MANIFEST sites only
```

**Content types:** `2=MANIFEST` (multi-file site), `3=FUNCTION`, `4=BLOB`, `5=INDEX snapshot`, `8=ENCRYPTED`

## Encrypted Sites

Sites can be encrypted for a specific gateway's public key. Encrypted sites (content-type 8) store a wrapped Content Encryption Key (CEK) in the manifest; the gateway decrypts on the fly using its X25519 private key.

```sh
# Get the gateway's public key
GET /vault/pubkey

# Publish an encrypted site
hybertext deploy ./site/ --encrypt --vault-pubkey <pubkey>
```

Encrypted sites appear in HyberIndex but are only readable by the designated gateway.

## Browser

**`HyberTextBrowser.app`** is a native macOS browser for browsing `bera://` sites — no gateway, no intermediary. It fetches calldata directly from the Berachain RPC, decodes the HYTE format, and renders in an embedded WebKit view.

**To run:** double-click `HyberTextBrowser.app`, or from the terminal:
```sh
open HyberTextBrowser.app
```

> First launch: macOS will show a Gatekeeper warning since the app isn't notarized. Right-click → Open to bypass, or run:
> ```sh
> xattr -d com.apple.quarantine HyberTextBrowser.app
> ```

**Navigating to a site:**
- Paste a transaction hash (`0x...`) into the address bar and press Return or click **Go**
- Try the live demo: `0x932e4f1078ffb36cc85aaea22ebbbb5b15047ab4abbbd2984f5e7f2800ed0311`

**Requirements:** macOS 13 (Ventura) or later. Universal binary — Apple Silicon and Intel.

**Build from source:**
```sh
cd packages/browser
swift build -c release
```

## Packages

| Package | Description |
|---------|-------------|
| `HyberTextBrowser.app` | Native macOS browser — browse `bera://` sites directly |
| `packages/browser` | Swift source for the macOS browser |
| `packages/cli` | Publisher CLI — `hybertext publish`, `hybertext deploy` |
| `packages/mcp` | MCP server + HTTP gateway — 25 agent tools, REST API, edge functions |
| `packages/db` | HyberDB client library — on-chain key-value store |
| `packages/contracts` | `HyberDB.sol`, `HyberIndex.sol`, `HyberRegistry.sol` |
| `spec/HYTE-format.md` | Binary format specification |

## Quick Start

### Publish a site

```sh
cd packages/cli
pnpm install && pnpm build

# Single HTML file
PRIVATE_KEY=0x... node dist/index.js publish ./index.html

# Multi-file site (includes functions/ automatically)
PRIVATE_KEY=0x... node dist/index.js publish ./my-site/

# Custom RPC
PRIVATE_KEY=0x... node dist/index.js publish ./site/ --rpc https://rpc.berachain.com
```

### Read and write HyberDB

```sh
# Read a namespace
curl https://hybertext-mcp.carnation-903.workers.dev/db/myproject/config

# Write a record
curl -X POST https://hybertext-mcp.carnation-903.workers.dev/db/myproject/config/theme \
  -H 'Content-Type: application/json' \
  -d '{"val": {"color": "dark", "font": "mono"}}'

# Query with filters
curl 'https://hybertext-mcp.carnation-903.workers.dev/db/myproject/users?where={"status":"active"}&orderBy=createdAt&limit=10'
```

### Self-host the gateway

```sh
cd packages/mcp
pnpm install

# Set secrets
wrangler secret put PRIVATE_KEY
wrangler secret put VAULT_X25519_PRIVKEY

# Deploy
pnpm wrangler deploy
```

Required env vars in `wrangler.toml`:
```toml
[vars]
BERACHAIN_RPC         = "https://rpc.berachain.com"
HYBERDB_ADDRESS       = "0x..."
HYBERINDEX_ADDRESS    = "0x..."
HYBERINDEX_FROM_BLOCK = "0x..."   # deployment block — avoids scanning from genesis

[[kv_namespaces]]
binding = "EDGE_KV"
id      = "..."
```

## Data Format (HYTE)

9-byte header prefix on every site transaction:

```
[4 bytes magic: HYTE][1 byte version][1 byte compression][1 byte content-type][2 bytes reserved]
[payload: compressed HTML or TAR archive]
```

Content types:
- `1` — Raw HTML (single file)
- `2` — MANIFEST (multi-file site or chunked payload)
- `3` — FUNCTION (edge function JS)
- `4` — BLOB (arbitrary binary data)
- `5` — INDEX (HyberIndex snapshot)
- `8` — ENCRYPTED (vault-encrypted site)

Sites over ~400KB compressed are split into multiple chunk transactions, with a manifest transaction referencing all chunks by tx hash and SHA-256. The manifest's tx hash is the public address.

See `spec/HYTE-format.md` for the full specification.

## Size and Cost

> Gas price from a real HyberText publish tx on Berachain mainnet: 0.000007215 gwei ([view tx](https://berascan.com/tx/0xfff68000dd4c9bc6198a9fa10959194fb8ea7f304b7b8afeb7f93ce3e0f1e80d)).

| Site type | Raw size | Compressed | ~Gas used | ~USD cost |
|-----------|----------|------------|-----------|-----------|
| Simple landing page | 5KB | 2KB | ~100K gas | <$0.000000001 |
| Full blog | 100KB | 40KB | ~1.8M gas | ~$0.000000013 |
| React app (bundled) | 500KB | 200KB | ~9M gas | ~$0.000000065 |
| Large app (chunked) | 2MB | 800KB | ~37M gas | ~$0.000000267 |

**Real-world example:** publishing the HyberText demo site (4,256 bytes compressed, 191K gas) cost **$0.000000001378** — roughly one billionth of a dollar. HyberDB writes are similarly cheap.

For comparison, a year of traditional web hosting costs $50–$200+. With HyberText you pay once (a fraction of a cent) and the site is up forever.

## Architecture

```
[hybertext publish] ─── calldata tx ──► [Berachain]
                                              │
                                         tx hash = site address
                                              │
[browser / agent] ──► [MCP / gateway] ──► [eth_getTransactionByHash]
                            │                    │
                       25 MCP tools         decode HYTE
                       REST /db/ API        decompress
                       Edge functions       serve files
                       KV cache layer
                            │
                       [Cloudflare KV]  ←── cache writes, warm reads
                            │
                       [HyberIndex] ──► eth_getLogs ──► discovery
```

### Read path (with KV cache)

```
GET /db/owner/collection/key
        │
        ├─ kv present? ──► getCached(kv, ns)
        │                       │
        │                  head match? ──► serve from KV (~89ms)
        │                       │
        │                  stale? ──────► fetchAndCache + serve
        │
        └─ no kv ──────────────► client.get(ns, key) chain traversal (~1.2s cold)
```
