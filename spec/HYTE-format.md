# HYTE Binary Format Specification
Version: 1

## Overview

HYTE (HYberText Encoding) is the binary envelope format used to store websites as
Berachain transaction calldata. Every published site begins with a 9-byte header
followed by the payload.

## Transaction Target

All site transactions are sent to the sink address:

```
0x000000000000000000000000000000000000dEaD
```

Value is always 0. The calldata IS the site.

## Header Layout (9 bytes)

```
Offset  Size  Type    Field
──────────────────────────────────────────────────────────────────
0       4     bytes   Magic: 0x48 0x59 0x54 0x45  ("HYTE")
4       1     uint8   Version: 0x01
5       1     uint8   Compression (see below)
6       1     uint8   Content-Type (see below)
7       2     bytes   Reserved: 0x00 0x00
9       N     bytes   Payload
```

## Compression Values

| Value | Encoding |
|-------|----------|
| 0x00  | None     |
| 0x01  | gzip     |
| 0x02  | brotli   |

## Content-Type Values

| Value | Description                                 |
|-------|---------------------------------------------|
| 0x00  | Single HTML file                            |
| 0x01  | TAR archive (multi-file site)               |
| 0x02  | Manifest (chunked site, see below)          |

## Single-File Site

For sites under ~400KB compressed:

```
[HYTE header][compressed HTML bytes]
```

The resolver serves the decompressed bytes with `Content-Type: text/html`.

## Multi-File Site (TAR)

For sites with multiple assets (HTML + CSS + JS + images):

```
[HYTE header][compressed TAR archive]
```

The TAR archive contains all site files. The resolver extracts the archive in
memory and serves individual files by path. `index.html` at the archive root
is served at the site root (`/`).

## Chunked Site (Manifest)

For compressed payloads over ~400KB, the site is split across multiple transactions.

**Chunk transactions** (raw, no HYTE header):
```
[raw bytes — sequential slice of the compressed payload]
```

**Manifest transaction** (HYTE header with content-type=0x02, compression=0x00):
```
[HYTE header (compression=NONE, content-type=MANIFEST)][UTF-8 JSON manifest]
```

**Manifest JSON schema:**
```json
{
  "v": 1,
  "compression": 2,
  "content_type": 1,
  "chunks": [
    "0xabc123...",
    "0xdef456...",
    "0x789abc..."
  ],
  "total_size": 1234567
}
```

- `compression` and `content_type` describe the **reassembled** payload (not individual chunks)
- `chunks` is an ordered array of transaction hashes
- The resolver fetches all chunks in parallel, concatenates in order, then decompresses

## Resolver Flow

```
1. eth_getTransactionByHash(txhash)
2. tx.input → strip 0x → Buffer
3. Validate magic bytes [0x48, 0x59, 0x54, 0x45]
4. Read compression + content_type from header
5. If content_type == MANIFEST:
     a. Parse JSON from payload bytes
     b. Fetch all chunk txs in parallel (raw .input, no header)
     c. Concatenate chunks in declared order
     d. Use manifest's compression + content_type for next steps
6. Decompress payload per compression field
7. If content_type == HTML: serve as text/html
8. If content_type == TAR: extract, serve requested path
```

## Size Limits

Targeting Berachain's ~30M block gas limit and leaving room for other transactions:

- Safe single-tx calldata: ~400KB compressed
- Chunk size for large sites: 400KB per chunk
- Practical max for single-file HTML (brotli): ~1.5MB raw HTML → ~400KB compressed

## Addressing

The transaction hash of the manifest (or single-tx) is the immutable "address" of the site.

Human-readable names can be registered in the `HyberRegistry` contract which maps
`keccak256(name) => txhash`. Updating a name (after republishing) costs one registry tx.
