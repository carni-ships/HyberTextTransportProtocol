# HyberText

Decentralized website hosting on Berachain. Sites are stored as calldata in
transactions — the transaction hash is the permanent, immutable address of the site.

## Why HyberText

Traditional websites depend on servers, DNS registrars, CDNs, and hosting providers — any one of which can go down, censor content, or disappear. HyberText eliminates every one of those dependencies by storing the website directly on an L1 blockchain.

**Decentralized** — There is no host. The site lives across every Berachain node on the network. No single company or government can take it down by pressuring a hosting provider, because there is no hosting provider.

**Uncensorable** — Once a transaction is finalized on Berachain it cannot be altered, removed, or blocked. The content is part of the chain's history. Any node, anywhere in the world, can serve it to any resolver.

**Permanent** — Calldata written to an L1 is there as long as the chain exists. No subscription renewals. No domain expiry. No S3 bucket accidentally made private. Pay once to publish; the site lives forever.

**Verifiable** — Because the site is calldata in a transaction, anyone can verify that what they're seeing is exactly what was published. The tx hash is both the address and the content hash.

## How it works

1. **Publish**: Compress your site, send it as calldata to Berachain
2. **Address**: The transaction hash is your site's address
3. **Resolve**: Any resolver fetches the tx, decodes the calldata, and serves the site

No servers. No DNS. No IPFS pinning. As long as Berachain exists, your site exists.

## Packages

| Package | Description |
|---|---|
| `packages/cli` | Publisher CLI — `hybertext publish` |
| `packages/resolver` | HTTP gateway — serves sites by tx hash |
| `packages/contracts` | `HyberRegistry.sol` — maps names to tx hashes |
| `spec/HYTE-format.md` | Binary format specification |

## Quick Start

### Publish a site

```sh
cd packages/cli
pnpm install && pnpm build

# Single HTML file
PRIVATE_KEY=0x... node dist/index.js publish ./index.html

# Multi-file site (bundles as tar)
PRIVATE_KEY=0x... node dist/index.js publish ./my-site/

# Custom RPC
PRIVATE_KEY=0x... node dist/index.js publish ./site/ --rpc https://rpc.berachain.com
```

Output:
```
Packing ./site/...
Packed: 12,450 bytes (brotli, tar)
Publishing to Berachain...

Site published!
  Address (tx hash): 0xabc123...
  Gateway URL:       https://hybertext.xyz/0xabc123...
  Local resolver:    http://localhost:3000/0xabc123...
```

### Run the resolver gateway

```sh
cd packages/resolver
cp .env.example .env
pnpm install && pnpm build
pnpm start
# → http://localhost:3000
```

Access any published site:
```
http://localhost:3000/0x{txhash}
http://localhost:3000/0x{txhash}/style.css
http://localhost:3000/0x{txhash}/js/app.js
```

### Deploy the naming registry (optional)

```sh
cd packages/contracts
forge install foundry-rs/forge-std
cp .env.example .env  # fill in keys

forge test  # run tests
forge script script/Deploy.s.sol --rpc-url $BERACHAIN_RPC --broadcast
```

Register a name:
```solidity
registry.register("mysite", 0xabc123...);  // first-come-first-served
registry.update("mysite",   0xdef456...);  // republish to new tx hash
registry.resolve("mysite"); // → 0xdef456...
```

## Data Format (HYTE)

9-byte header prefix on every site transaction:

```
[4 bytes magic: HYTE][1 byte version][1 byte compression][1 byte content-type][2 bytes reserved]
[payload: compressed HTML or TAR archive]
```

Sites over ~400KB compressed are split into multiple chunk transactions,
with a manifest transaction (content-type=2) referencing all chunks.
The manifest's tx hash is the public address.

See `spec/HYTE-format.md` for full specification.

## Size and Cost

> Estimates use the **observed gas price from a real HyberText publish transaction on Berachain mainnet: 0.000007215 gwei** ([view tx](https://berascan.com/tx/0xfff68000dd4c9bc6198a9fa10959194fb8ea7f304b7b8afeb7f93ce3e0f1e80d)).
> Assumes **BERA = $1**. Calldata is priced at ~16 gas per byte.

| Site type | Raw size | Compressed | ~Gas used | ~USD cost |
|---|---|---|---|---|
| Simple landing page | 5KB | 2KB | ~75K gas | ~$0.0000000054 |
| Full blog | 100KB | 40KB | ~700K gas | ~$0.000000051 |
| React app (bundled) | 500KB | 200KB | ~3.5M gas | ~$0.00000025 |
| Large app (chunked) | 2MB | 800KB | ~15M gas across 2 txs | ~$0.0000011 |

**Real-world example:** publishing the HyberText demo site (4,256 bytes compressed, 191K gas) cost **$0.000000001378** — roughly one billionth of a dollar.

For comparison, a year of traditional web hosting costs $50–$200+/yr. With HyberText you pay once (a fraction of a cent), and the site is up forever.

## Architecture

```
[hybertext publish] ─── calldata tx ──► [Berachain]
                                              │
                                         tx hash = site address
                                              │
[browser] ──► [resolver gateway] ──► [eth_getTransactionByHash]
                    │                         │
               extract tar              decode HYTE header
               serve files              decompress payload
                                        extract & serve
```
