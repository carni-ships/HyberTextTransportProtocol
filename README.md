# HyberText

Decentralized website hosting on Berachain. Sites are stored as calldata in
transactions — the transaction hash is the permanent, immutable address of the site.

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

| Site type | Raw size | Compressed | ~Gas cost | ~BERA cost |
|---|---|---|---|---|
| Simple landing page | 5KB | 2KB | ~75K gas | negligible |
| Full blog | 100KB | 40KB | ~700K gas | very cheap |
| React app (bundled) | 500KB | 200KB | ~3.5M gas | cheap |
| Large app (chunked) | 2MB | 800KB | ~15M gas across 2 txs | still cheap |

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
