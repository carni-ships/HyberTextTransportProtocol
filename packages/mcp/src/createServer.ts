import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveSite, extractTar, ContentType } from './resolver.js';
import { queryIndex } from './index-query.js';
import { publishHtml, type Env } from './upload.js';
import { HyberDBClient } from '@hybertext/db';
import {
  CONTENT_TYPE_INSIGHT, CONTENT_TYPE_STRATEGY,
  announceToIndex, nextResearchSeq,
  kvUpdateFeeds, kvUpdateCitedBy, kvGetFeed, kvGetCitedBy, kvGetInsightSummary,
  kvAddClaim, kvGetClaims, kvAddStrategy, kvGetStrategies,
  formatInsightSummary, formatStrategy, formatClaim,
  getUnclaimedDirections, updateLeaderboardAndCitations, getLeaderboard,
  trackDirectionFitness, getDirectionFitness, detectStagnation,
  getCitationTree, flattenCitationTree,
  kvAddBounty, kvGetBounties, kvGetBounty, kvUpdateBounty, verifyBountyQualification, formatBounty,
  kvGetAgentIdentity, kvSetAgentIdentity, kvGetAgentRep, kvUpdateAgentRep, kvGetRepLeaderboard, formatRepSummary,
  kvAddPost, kvGetChannel, kvGetBoardChannels, formatBoardThread,
  type Insight, type DirectionClaim, type ResearchStrategy, type CitationNode, type ResearchBounty,
  type AgentIdentityReg, type AgentRepSummary, type BoardPost,
} from './research.js';
import {
  identityGetTokenId, identityGetRegistration, identityRegister,
  repGetScore, repSubmitFeedback, getTokenIdFromReceipt, formatRepScore,
} from './erc8004.js';
import {
  acpReadJob, acpWrite, acpJobCount, erc20Approve, waitReceipt,
  getJobIdFromReceipt, formatJob,
  encodeCreateJob, encodeSetProvider, encodeSetBudget, encodeFund,
  encodeSubmit, encodeComplete, encodeReject, encodeClaimRefund,
  ZERO_ADDRESS,
  type ACPJobMeta,
} from './acp.js';

const TEXT_EXTENSIONS = /\.(html|htm|css|js|mjs|json|txt|md|svg|xml)$/i;
const MAX_FILE_BYTES  = 50 * 1024;

// Agent card schema — stored in HyberDB at {address}/agent, key "card"
// and cached in KV under agent:{address}
interface AgentCard {
  name:         string;
  description:  string;
  capabilities: string[];
  endpoint?:    string;  // e.g. gateway URL for calling this agent
  address:      string;  // wallet address (filled automatically)
  updatedAt:    number;
}

function gatewayOrigin(env?: Env): string {
  return env?.BASE_DOMAIN
    ? `https://${env.BASE_DOMAIN}`
    : 'https://hybertext-mcp.carnation-903.workers.dev';
}

function dbClient(rpcUrl: string, env: Env, write = false): HyberDBClient {
  if (write && !env.PRIVATE_KEY) throw new Error('PRIVATE_KEY not configured — writes are disabled');
  return new HyberDBClient({
    rpcUrl,
    contractAddress: env.HYBERDB_ADDRESS as `0x${string}`,
    ...(write && env.PRIVATE_KEY ? { privateKey: env.PRIVATE_KEY as `0x${string}` } : {}),
  });
}

export function createServer(rpcUrl: string, env?: Env): McpServer {
  const server = new McpServer({ name: 'hybertext', version: '0.1.0' });

  // ---------------------------------------------------------------------------
  // fetch_hybertext_site — read a site stored on-chain
  // ---------------------------------------------------------------------------

  server.tool(
    'fetch_hybertext_site',
    `Fetch and read a website stored as calldata on Berachain (HyberText format).
Returns a file listing and the text content of all readable files (HTML, CSS, JS, etc.).
Binary files are listed but their content is omitted.`,
    {
      txHash: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a 0x-prefixed 64-hex-char tx hash')
        .describe('Berachain transaction hash that stores the site (0x...)'),
    },
    async ({ txHash }) => {
      const decoded = await resolveSite(txHash as `0x${string}`, rpcUrl);

      const files: Map<string, Buffer> =
        decoded.contentType === ContentType.HTML
          ? new Map([['index.html', decoded.payload]])
          : await extractTar(decoded.payload);

      const lines: string[] = [];
      lines.push(`HyberText site @ ${txHash}`);
      lines.push(`${files.size} file(s):\n`);

      for (const [path, buf] of files) {
        lines.push(`  ${path}  (${buf.length.toLocaleString()} bytes)`);
      }

      for (const [path, buf] of files) {
        if (!TEXT_EXTENSIONS.test(path)) continue;
        lines.push(`\n${'─'.repeat(60)}`);
        lines.push(`FILE: ${path}`);
        lines.push('─'.repeat(60));
        if (buf.length <= MAX_FILE_BYTES) {
          lines.push(buf.toString('utf8'));
        } else {
          lines.push(buf.subarray(0, MAX_FILE_BYTES).toString('utf8'));
          lines.push(`\n[... truncated — file is ${buf.length.toLocaleString()} bytes, showing first 50 KB]`);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ---------------------------------------------------------------------------
  // site_url — resolve gateway URL for a txHash
  // ---------------------------------------------------------------------------

  server.tool(
    'site_url',
    `Return the gateway URL where a HyberText site is served.
Use this after site_publish to get a shareable link, or to construct fn_call paths.`,
    {
      txHash: z
        .string()
        .regex(/^0x[a-fA-F0-9]{64}$/)
        .describe('Transaction hash of the site'),
    },
    async ({ txHash }) => {
      const url = `${gatewayOrigin(env)}/${txHash}/`;
      return { content: [{ type: 'text' as const, text: url }] };
    }
  );

  // ---------------------------------------------------------------------------
  // index_query — discover published sites via HyberIndex
  // ---------------------------------------------------------------------------

  server.tool(
    'index_query',
    `Query the HyberIndex to discover websites published on Berachain.
Returns a list of recent publishes with txHash, publisher address, content type, and timestamp.
Content types: 2=MANIFEST (multi-file site), 4=BLOB, 5=INDEX snapshot, 8=ENCRYPTED.
Use fetch_hybertext_site to read the content of any returned txHash.`,
    {
      publisher:   z.string().optional().describe('Filter by publisher address (0x...)'),
      limit:       z.number().int().min(1).max(500).optional().default(20).describe('Max entries to return (default 20)'),
      contentType: z.number().int().optional().describe('Filter by content type: 2=MANIFEST, 4=BLOB, 5=INDEX, 8=ENCRYPTED'),
    },
    async ({ publisher, limit, contentType }) => {
      if (!env?.HYBERINDEX_ADDRESS) {
        return { content: [{ type: 'text' as const, text: 'HyberIndex not configured on this gateway.' }] };
      }
      const fromBlock = env.HYBERINDEX_FROM_BLOCK ?? '0x0';
      let entries = await queryIndex(env.HYBERINDEX_ADDRESS, rpcUrl, { publisher, limit: limit ?? 20, fromBlock });
      if (contentType !== undefined) entries = entries.filter(e => e.contentType === contentType);

      if (!entries.length) {
        return { content: [{ type: 'text' as const, text: 'No entries found.' }] };
      }

      const ctLabel: Record<number, string> = { 2: 'MANIFEST', 4: 'BLOB', 5: 'INDEX', 8: 'ENCRYPTED' };
      const lines = entries.map(e => {
        const ts  = e.timestamp ? new Date(e.timestamp * 1000).toISOString() : 'unknown';
        const ct  = ctLabel[e.contentType] ?? `TYPE_${e.contentType}`;
        return `${e.txHash}  ${ct}  ${e.publisher}  ${ts}  block ${e.blockNumber}`;
      });

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    }
  );

  // ---------------------------------------------------------------------------
  // site_publish — publish HTML/text content as a new site on-chain
  // ---------------------------------------------------------------------------

  server.tool(
    'site_publish',
    `Publish HTML (or any text content) as a new HyberText site on Berachain.
Stores content in calldata, returns the transaction hash that permanently addresses this site.
The site is immediately accessible at: https://<gateway>/<txHash>/
Requires PRIVATE_KEY to be configured on the gateway.`,
    {
      content:  z.string().describe('HTML or text content to publish'),
      filename: z.string().optional().default('index.html').describe('Filename for the content (default: index.html)'),
    },
    async ({ content, filename }) => {
      if (!env?.PRIVATE_KEY) {
        return { content: [{ type: 'text' as const, text: 'Error: PRIVATE_KEY not configured — site publishing is disabled.' }] };
      }
      try {
        const result = await publishHtml(content, filename ?? 'index.html', env, gatewayOrigin(env));
        return { content: [{ type: 'text' as const, text: `Published!\ntxHash: ${result.txHash}\nURL: ${result.gatewayUrl}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // fn_call — invoke an on-chain edge function
  // ---------------------------------------------------------------------------

  server.tool(
    'fn_call',
    `Call an edge function that is part of a HyberText site stored on-chain.
The function runs at: https://<gateway>/<txHash>/<path>
Useful for calling another agent's published API endpoint.
Returns the response body as text (truncated at 50 KB).`,
    {
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('Transaction hash of the site containing the function'),
      path:   z.string().optional().default('').describe('Path after the txHash (e.g. "api/greet")'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().default('GET').describe('HTTP method (default GET)'),
      body:   z.string().optional().describe('Request body (for POST/PUT/PATCH)'),
    },
    async ({ txHash, path, method, body }) => {
      const url  = `${gatewayOrigin(env)}/${txHash}/${path ?? ''}`;
      const opts: RequestInit = { method: method ?? 'GET', headers: { 'Content-Type': 'application/json' } };
      if (body) opts.body = body;
      try {
        const res  = await fetch(url, opts);
        const text = await res.text();
        const out  = text.length > 50_000 ? text.slice(0, 50_000) + '\n[... truncated]' : text;
        return { content: [{ type: 'text' as const, text: `HTTP ${res.status}\n${out}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // db_namespace_info — check if a namespace exists and get its metadata
  // ---------------------------------------------------------------------------

  server.tool(
    'db_namespace_info',
    `Get metadata for a HyberDB namespace: owner address, head pointer, last updated time.
Returns null if the namespace does not exist yet.
Use this to check before writing, or to get the current head for cache validation.`,
    {
      namespace: z.string().describe('Namespace in "owner/collection" format'),
    },
    async ({ namespace }) => {
      if (!env?.HYBERDB_ADDRESS) {
        return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      }
      try {
        const client = dbClient(rpcUrl, env);
        const info   = await client.info(namespace);
        if (!info) return { content: [{ type: 'text' as const, text: `Namespace "${namespace}" does not exist.` }] };
        return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // db_read — read from HyberDB
  // ---------------------------------------------------------------------------

  server.tool(
    'db_read',
    `Read data from HyberDB, an on-chain key-value store built on Berachain.
Namespaces follow the pattern "owner/collection" (e.g. "myapp/users").
If key is omitted, returns all records in the namespace.
Supports optional where/orderBy/limit/offset filters when reading all records.`,
    {
      namespace: z.string().describe('Namespace in "owner/collection" format'),
      key:       z.string().optional().describe('Record key to read (omit to list all records)'),
      where:     z.record(z.unknown()).optional().describe('Filter records by field equality, e.g. {"status":"active"}'),
      orderBy:   z.string().optional().describe('Field name to sort by'),
      orderDir:  z.enum(['asc', 'desc']).optional().describe('Sort direction'),
      limit:     z.number().int().positive().optional().describe('Max records to return'),
      offset:    z.number().int().nonnegative().optional().describe('Records to skip'),
    },
    async ({ namespace, key, where, orderBy, orderDir, limit, offset }) => {
      if (!env?.HYBERDB_ADDRESS) {
        return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      }
      try {
        const client = dbClient(rpcUrl, env);
        if (key) {
          const val = await client.get(namespace, key);
          if (val === null) return { content: [{ type: 'text' as const, text: `Record "${key}" not found in "${namespace}".` }] };
          return { content: [{ type: 'text' as const, text: JSON.stringify({ key, val }, null, 2) }] };
        }
        const result = await client.getAll(namespace, { where: where as any, orderBy, orderDir, limit, offset });
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // db_write — write a single record to HyberDB
  // ---------------------------------------------------------------------------

  server.tool(
    'db_write',
    `Write a record to HyberDB (on-chain key-value store).
Namespace format: "owner/collection". Value can be any JSON (object, string, number, array).
Returns the transaction hash of the write operation.
Requires PRIVATE_KEY on the gateway.`,
    {
      namespace: z.string().describe('Namespace in "owner/collection" format'),
      key:       z.string().describe('Record key'),
      val:       z.unknown().describe('JSON value to store'),
    },
    async ({ namespace, key, val }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      try {
        const txHash = await dbClient(rpcUrl, env, true).set(namespace, key, val as any);
        return { content: [{ type: 'text' as const, text: `Written!\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // db_merge — partial update (PATCH) a record in HyberDB
  // ---------------------------------------------------------------------------

  server.tool(
    'db_merge',
    `Partially update a HyberDB record by merging fields into the existing object.
Only the provided fields are changed; other fields are preserved.
Use this instead of db_write when multiple agents may update different fields of the same record.
Value must be a plain object. Requires PRIVATE_KEY on the gateway.`,
    {
      namespace: z.string().describe('Namespace in "owner/collection" format'),
      key:       z.string().describe('Record key to update'),
      val:       z.record(z.unknown()).describe('Fields to merge into the existing record'),
    },
    async ({ namespace, key, val }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      try {
        const txHash = await dbClient(rpcUrl, env, true).merge(namespace, key, val as any);
        return { content: [{ type: 'text' as const, text: `Merged!\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // db_batch — multi-key write in a single transaction
  // ---------------------------------------------------------------------------

  server.tool(
    'db_batch',
    `Write multiple records to a HyberDB namespace in a single on-chain transaction.
Much cheaper than individual db_write calls when updating many keys at once.
Each op is { op: "set"|"del", key: string, val?: JsonValue }.
Requires PRIVATE_KEY on the gateway.`,
    {
      namespace: z.string().describe('Namespace in "owner/collection" format'),
      ops: z.array(z.object({
        op:  z.enum(['set', 'del']).describe('"set" to write, "del" to delete'),
        key: z.string().describe('Record key'),
        val: z.unknown().optional().describe('Value for "set" operations'),
      })).describe('Array of operations to execute atomically'),
    },
    async ({ namespace, ops }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      try {
        const txHash = await dbClient(rpcUrl, env, true).batch(namespace, ops as any);
        return { content: [{ type: 'text' as const, text: `Batch complete!\ntxHash: ${txHash}\n${ops.length} operation(s) applied.` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // db_delete — delete a record
  // ---------------------------------------------------------------------------

  server.tool(
    'db_delete',
    `Delete a record from HyberDB. Requires PRIVATE_KEY on the gateway.`,
    {
      namespace: z.string().describe('Namespace in "owner/collection" format'),
      key:       z.string().describe('Record key to delete'),
    },
    async ({ namespace, key }) => {
      if (!env?.HYBERDB_ADDRESS || !env?.PRIVATE_KEY) {
        return { content: [{ type: 'text' as const, text: 'HyberDB or PRIVATE_KEY not configured.' }] };
      }
      try {
        const txHash = await dbClient(rpcUrl, env, true).del(namespace, key);
        return { content: [{ type: 'text' as const, text: `Deleted!\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // kv_get / kv_set / kv_delete / kv_list / kv_increment
  // ---------------------------------------------------------------------------

  server.tool(
    'kv_get',
    `Read a value from edge KV storage (fast, globally replicated).
Returns the raw string value, or "Key not found" if missing.`,
    { key: z.string().describe('KV key') },
    async ({ key }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'Edge KV not configured.' }] };
      const value = await (env.EDGE_KV as any).get(key);
      return { content: [{ type: 'text' as const, text: value ?? `Key "${key}" not found.` }] };
    }
  );

  server.tool(
    'kv_set',
    `Write a value to edge KV storage. Values are strings (use JSON.stringify for objects).
Optional TTL in seconds after which the key expires automatically.`,
    {
      key:   z.string().describe('KV key'),
      value: z.string().describe('String value to store'),
      ttl:   z.number().int().positive().optional().describe('TTL in seconds'),
    },
    async ({ key, value, ttl }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'Edge KV not configured.' }] };
      await (env.EDGE_KV as any).put(key, value, ttl ? { expirationTtl: ttl } : undefined);
      return { content: [{ type: 'text' as const, text: `Stored "${key}".` }] };
    }
  );

  server.tool(
    'kv_delete',
    `Delete a key from edge KV storage.`,
    { key: z.string().describe('KV key to delete') },
    async ({ key }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'Edge KV not configured.' }] };
      await (env.EDGE_KV as any).delete(key);
      return { content: [{ type: 'text' as const, text: `Deleted "${key}".` }] };
    }
  );

  server.tool(
    'kv_list',
    `List keys in edge KV storage matching a prefix.
Returns up to 100 key names. Use prefix="" to list all keys.
Useful for implementing task queues, mailboxes, and enumerating agent state.`,
    {
      prefix: z.string().describe('Key prefix to filter by (empty string = all keys)'),
      limit:  z.number().int().positive().max(100).optional().default(50).describe('Max keys to return (default 50)'),
    },
    async ({ prefix, limit }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'Edge KV not configured.' }] };
      const kv = env.EDGE_KV as any;
      if (!kv.list) return { content: [{ type: 'text' as const, text: 'KV list not available.' }] };
      const result = await kv.list({ prefix, limit: limit ?? 50 });
      const keys: string[] = (result.keys ?? []).map((k: any) => k.name);
      if (!keys.length) return { content: [{ type: 'text' as const, text: `No keys found with prefix "${prefix}".` }] };
      return { content: [{ type: 'text' as const, text: keys.join('\n') }] };
    }
  );

  server.tool(
    'kv_increment',
    `Atomically increment (or decrement) a numeric counter in KV storage.
Creates the key with value 0 before incrementing if it doesn't exist.
Returns the new value. Use negative "by" to decrement.
Useful for shared counters, rate limiting, and task queue depth tracking.`,
    {
      key: z.string().describe('KV key for the counter'),
      by:  z.number().int().optional().default(1).describe('Amount to add (negative to subtract, default 1)'),
    },
    async ({ key, by }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'Edge KV not configured.' }] };
      const kv     = env.EDGE_KV as any;
      const raw    = await kv.get(key);
      const prev   = raw !== null ? parseInt(raw, 10) : 0;
      const next   = prev + (by ?? 1);
      await kv.put(key, String(next));
      return { content: [{ type: 'text' as const, text: String(next) }] };
    }
  );

  // ---------------------------------------------------------------------------
  // agent_register — publish an agent card (on-chain + KV cache)
  // ---------------------------------------------------------------------------

  server.tool(
    'agent_register',
    `Register this agent with a discoverable card stored on-chain in HyberDB and cached in KV.
The card is stored at: {walletAddress}/agent, key "card"
Other agents can find it via agent_discover.
Requires both PRIVATE_KEY and HYBERDB_ADDRESS on the gateway.`,
    {
      name:         z.string().describe('Short agent name'),
      description:  z.string().describe('What this agent does'),
      capabilities: z.array(z.string()).describe('List of capability tags, e.g. ["data-analysis","code-gen"]'),
      endpoint:     z.string().optional().describe('Gateway URL or contact endpoint for this agent'),
    },
    async ({ name, description, capabilities, endpoint }) => {
      if (!env?.HYBERDB_ADDRESS || !env?.PRIVATE_KEY) {
        return { content: [{ type: 'text' as const, text: 'HYBERDB_ADDRESS and PRIVATE_KEY required.' }] };
      }
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const address = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        const namespace = `${address}/agent`;
        const card: AgentCard = { name, description, capabilities, endpoint, address, updatedAt: Math.floor(Date.now() / 1000) };

        const txHash = await dbClient(rpcUrl, env, true).set(namespace, 'card', card as any);

        // Cache in KV for fast discovery
        if (env.EDGE_KV) {
          await (env.EDGE_KV as any).put(`agent:${address}`, JSON.stringify(card));
        }

        return { content: [{ type: 'text' as const, text: `Registered!\nAddress: ${address}\nNamespace: ${namespace}\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // agent_discover — find registered agents
  // ---------------------------------------------------------------------------

  server.tool(
    'agent_discover',
    `Discover registered agents on this gateway.
Returns agent cards from the KV cache (fast) plus optionally checks on-chain for a specific address.
Filter by capability tag to find agents that can help with a specific task.`,
    {
      capability: z.string().optional().describe('Filter by capability tag (e.g. "code-gen")'),
      address:    z.string().optional().describe('Look up a specific agent by wallet address'),
    },
    async ({ capability, address }) => {
      // If looking up a specific address, check on-chain first
      if (address && env?.HYBERDB_ADDRESS) {
        try {
          const ns   = `${address.toLowerCase()}/agent`;
          const card = await dbClient(rpcUrl, env).get(ns, 'card') as AgentCard | null;
          if (card) {
            return { content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }] };
          }
          return { content: [{ type: 'text' as const, text: `No agent card found for ${address}.` }] };
        } catch (e: unknown) {
          return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
        }
      }

      // Otherwise scan KV cache
      if (!env?.EDGE_KV) {
        return { content: [{ type: 'text' as const, text: 'Edge KV not configured — cannot list agents.' }] };
      }
      const kv = env.EDGE_KV as any;
      if (!kv.list) {
        return { content: [{ type: 'text' as const, text: 'KV list not available.' }] };
      }

      const result = await kv.list({ prefix: 'agent:', limit: 100 });
      const keys: string[] = (result.keys ?? []).map((k: any) => k.name);
      if (!keys.length) {
        return { content: [{ type: 'text' as const, text: 'No registered agents found.' }] };
      }

      const cards: AgentCard[] = [];
      for (const k of keys) {
        const raw = await kv.get(k);
        if (!raw) continue;
        try {
          const card = JSON.parse(raw) as AgentCard;
          if (!capability || card.capabilities?.includes(capability)) {
            cards.push(card);
          }
        } catch { /* skip malformed */ }
      }

      if (!cards.length) {
        return { content: [{ type: 'text' as const, text: capability ? `No agents found with capability "${capability}".` : 'No agents found.' }] };
      }

      // Augment cards with ERC-8004 reputation if available
      const lines = await Promise.all(cards.map(async c => {
        let repLine = '';
        if (kv) {
          const rep = await kvGetAgentRep(kv, c.address);
          if (rep) repLine = `\n  reputation: ${(rep.score >= 0 ? '+' : '') + rep.score.toFixed(4)}  (${rep.feedbackCount} feedbacks, ${rep.bountiesClaimed} bounties)`;
        }
        return `${c.address}  ${c.name}\n  ${c.description}\n  capabilities: ${c.capabilities.join(', ')}${c.endpoint ? `\n  endpoint: ${c.endpoint}` : ''}${repLine}`;
      }));
      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    }
  );

  // ---------------------------------------------------------------------------
  // agent_identity_register — ERC-8004 identity mint
  // ---------------------------------------------------------------------------

  server.tool(
    'agent_identity_register',
    `Register this agent with an ERC-8004 identity token on Berachain.
Mints a HyberAgentIdentity ERC-721 token that serves as a portable, permanent agent identifier.
The tokenId is the basis for all ERC-8004 reputation accumulation.

Portable identifier format: eip155:80094:{contractAddress}:{tokenId}
One registration per wallet address. Name must be unique across all registered agents.
Requires PRIVATE_KEY + AGENT_IDENTITY_ADDRESS.`,
    {
      name:        z.string().max(64).describe('Unique agent name (max 64 chars)'),
      description: z.string().describe('What this agent does'),
      mcpEndpoint: z.string().optional().default('').describe('MCP server URL (or gateway endpoint)'),
      tags:        z.array(z.string()).optional().default([]).describe('Capability tags, e.g. ["research", "gpt-training"]'),
    },
    async ({ name, description, mcpEndpoint, tags }) => {
      if (!env?.PRIVATE_KEY)               return { content: [{ type: 'text' as const, text: 'PRIVATE_KEY not configured.' }] };
      if (!env?.AGENT_IDENTITY_ADDRESS)    return { content: [{ type: 'text' as const, text: 'AGENT_IDENTITY_ADDRESS not configured — deploy HyberAgentIdentity.sol first.' }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const ownerAddr = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        const rpcUrl    = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';

        // Check if already registered
        const existing = await identityGetTokenId(ownerAddr, env.AGENT_IDENTITY_ADDRESS, rpcUrl);
        if (existing > 0) {
          return { content: [{ type: 'text' as const, text: `Already registered — tokenId: ${existing}\nUse agent_identity_get to view your registration.` }] };
        }

        const txHash = await identityRegister(env, name, description, mcpEndpoint ?? '', tags ?? []);

        // Wait for receipt to get tokenId
        const tokenId = await getTokenIdFromReceipt(rpcUrl, txHash, env.AGENT_IDENTITY_ADDRESS);

        // Cache in KV
        if (env.EDGE_KV && tokenId) {
          const reg: AgentIdentityReg = {
            tokenId, owner: ownerAddr, name, description,
            mcpEndpoint: mcpEndpoint ?? '', tags: tags ?? [],
            registeredAt: Math.floor(Date.now() / 1000),
            updatedAt:    Math.floor(Date.now() / 1000),
          };
          await kvSetAgentIdentity(env.EDGE_KV as any, reg);
        }

        const lines = [
          `ERC-8004 identity registered!`,
          `  txHash:  ${txHash}`,
          `  tokenId: ${tokenId ?? '(pending — check receipt)'}`,
          `  owner:   ${ownerAddr}`,
          `  name:    ${name}`,
          `  tags:    ${(tags ?? []).join(', ') || '(none)'}`,
          `\nPortable id: eip155:80094:${env.AGENT_IDENTITY_ADDRESS}:${tokenId ?? '?'}`,
          `Your agent now accumulates ERC-8004 reputation via bounty claims and citations.`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // agent_identity_get — ERC-8004 identity lookup
  // ---------------------------------------------------------------------------

  server.tool(
    'agent_identity_get',
    `Look up the ERC-8004 identity registration for an agent.
Returns registration details (name, description, MCP endpoint, tags) plus on-chain reputation score.
Queries the chain directly if not found in the KV cache.
Requires AGENT_IDENTITY_ADDRESS (AGENT_REPUTATION_ADDRESS optional for score).`,
    {
      address: z.string().optional().describe('Agent wallet address (defaults to this gateway wallet)'),
      tokenId: z.number().int().optional().describe('ERC-8004 tokenId (alternative to address lookup)'),
    },
    async ({ address, tokenId }) => {
      if (!env?.AGENT_IDENTITY_ADDRESS) return { content: [{ type: 'text' as const, text: 'AGENT_IDENTITY_ADDRESS not configured.' }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const rpcUrl = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
        const lookupAddr = (address ?? (env.PRIVATE_KEY ? privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address : '')).toLowerCase();

        // Resolve tokenId
        let tid = tokenId;
        if (!tid && lookupAddr) {
          tid = await identityGetTokenId(lookupAddr, env.AGENT_IDENTITY_ADDRESS, rpcUrl);
        }
        if (!tid || tid === 0) {
          return { content: [{ type: 'text' as const, text: `No ERC-8004 identity found for ${lookupAddr || 'this wallet'}.\nCall agent_identity_register to mint one.` }] };
        }

        // Try KV cache first, then chain
        const kv = env.EDGE_KV as any;
        let reg = kv ? await kvGetAgentIdentity(kv, lookupAddr) : null;
        if (!reg) {
          const onChain = await identityGetRegistration(tid, env.AGENT_IDENTITY_ADDRESS, rpcUrl);
          if (!onChain) return { content: [{ type: 'text' as const, text: `Token ${tid} not found on-chain.` }] };
          reg = { tokenId: tid, owner: lookupAddr, ...onChain };
        }

        const lines = [
          `ERC-8004 Identity — tokenId: ${reg.tokenId}`,
          `  owner:      ${reg.owner}`,
          `  name:       ${reg.name}`,
          `  endpoint:   ${reg.mcpEndpoint || '(not set)'}`,
          `  tags:       ${reg.tags.join(', ') || '(none)'}`,
          `  registered: ${new Date(reg.registeredAt * 1000).toISOString()}`,
          `  portable:   eip155:80094:${env.AGENT_IDENTITY_ADDRESS}:${reg.tokenId}`,
        ];

        // Reputation score
        if (env.AGENT_REPUTATION_ADDRESS) {
          const { score, count } = await repGetScore(reg.tokenId, env.AGENT_REPUTATION_ADDRESS, rpcUrl);
          lines.push(`  reputation: ${formatRepScore(score, count)}`);
        }

        // KV rep summary
        if (kv) {
          const repSummary = await kvGetAgentRep(kv, reg.owner);
          if (repSummary) {
            lines.push(`  citations:  ${repSummary.citationScore}  |  bounties: ${repSummary.bountiesClaimed}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // agent_reputation_get — ERC-8004 reputation score for an agent
  // ---------------------------------------------------------------------------

  server.tool(
    'agent_reputation_get',
    `Get the ERC-8004 reputation score for an agent.
Shows on-chain feedback score plus KV-cached citation and bounty counts.
Score is a signed value (1e18 denominator): positive = trusted, negative = penalised.
Sources: bounty claims (+0.01 per claim), bounty rejections (−0.005), gateway citations (dripped off-chain).
Requires AGENT_IDENTITY_ADDRESS + AGENT_REPUTATION_ADDRESS.`,
    {
      address: z.string().optional().describe('Agent wallet address (defaults to this gateway wallet)'),
    },
    async ({ address }) => {
      if (!env?.AGENT_IDENTITY_ADDRESS)   return { content: [{ type: 'text' as const, text: 'AGENT_IDENTITY_ADDRESS not configured.' }] };
      if (!env?.AGENT_REPUTATION_ADDRESS) return { content: [{ type: 'text' as const, text: 'AGENT_REPUTATION_ADDRESS not configured.' }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const rpcUrl     = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
        const lookupAddr = (address ?? (env.PRIVATE_KEY ? privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address : '')).toLowerCase();
        if (!lookupAddr) return { content: [{ type: 'text' as const, text: 'Provide address or configure PRIVATE_KEY.' }] };

        const tokenId = await identityGetTokenId(lookupAddr, env.AGENT_IDENTITY_ADDRESS, rpcUrl);
        if (tokenId === 0) {
          return { content: [{ type: 'text' as const, text: `${lookupAddr} has no ERC-8004 identity. Call agent_identity_register first.` }] };
        }

        const [{ score, count }, kvRep] = await Promise.all([
          repGetScore(tokenId, env.AGENT_REPUTATION_ADDRESS, rpcUrl),
          env.EDGE_KV ? kvGetAgentRep(env.EDGE_KV as any, lookupAddr) : Promise.resolve(null),
        ]);

        const lines = [
          `ERC-8004 Reputation — ${lookupAddr}`,
          `  tokenId:   ${tokenId}`,
          `  score:     ${formatRepScore(score, count)}  (on-chain)`,
        ];
        if (kvRep) {
          lines.push(`  citations: ${kvRep.citationScore}  (times cited by other agents)`);
          lines.push(`  bounties:  ${kvRep.bountiesClaimed}  (claimed and completed)`);
          lines.push(`  combined:  ${(Number(score) / 1e18 + kvRep.citationScore * 0.001).toFixed(4)}  (score + 0.001×citations)`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // agent_reputation_list — ERC-8004 reputation leaderboard
  // ---------------------------------------------------------------------------

  server.tool(
    'agent_reputation_list',
    `List agents sorted by ERC-8004 reputation score (highest first).
Combines on-chain feedback score + KV citation counts into a single ranking.
Agents appear here after receiving their first feedback via bounty claims or citations.
Requires EDGE_KV. AGENT_REPUTATION_ADDRESS optional (shows KV-only data if absent).`,
    {
      limit: z.number().int().min(1).max(50).optional().default(20),
    },
    async ({ limit }) => {
      const kv = env?.EDGE_KV as any;
      if (!kv) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const reps = await kvGetRepLeaderboard(kv, limit ?? 20);
        if (!reps.length) {
          return { content: [{ type: 'text' as const, text: 'No reputation data yet.\nAgents appear here after claiming bounties or being cited.' }] };
        }

        const lines = [
          `ERC-8004 Reputation Leaderboard (top ${reps.length}):`,
          '',
          ...reps.map((r, i) => `${i + 1}. ${formatRepSummary(r)}`),
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ---------------------------------------------------------------------------
  // Taskboard — Linear-style task management over HyberDB
  //
  // Namespace layout  (workspace = e.g. "my-team"):
  //   {workspace}/tasks    — task records, key = "T-{n}"
  //   {workspace}/projects — project records, key = project id slug
  //   {workspace}/comments — comment records, key = "{taskId}:{n}"
  //
  // KV counters:
  //   taskboard:{workspace}:task_seq    — auto-increment for T-{n}
  //   taskboard:{workspace}:comment_seq — auto-increment for comments
  // ---------------------------------------------------------------------------

  type TaskStatus   = 'todo' | 'in-progress' | 'in-review' | 'done' | 'cancelled';
  type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

  interface Task {
    id:           string;
    project:      string;
    title:        string;
    description:  string;
    status:       TaskStatus;
    priority:     TaskPriority;
    assignee:     string | null;
    labels:       string[];
    createdBy:    string | null;
    createdAt:    number;
    updatedAt:    number;
    resultTxHash: string | null;
    parentId:     string | null;
  }

  interface TaskComment {
    id:        string;
    taskId:    string;
    author:    string | null;
    body:      string;
    createdAt: number;
  }

  interface Project {
    id:          string;
    name:        string;
    description: string;
    status:      'active' | 'paused' | 'completed';
    createdBy:   string | null;
    createdAt:   number;
  }

  function requireTaskboard(): string | null {
    if (!env?.HYBERDB_ADDRESS) return 'HyberDB not configured.';
    if (!env?.PRIVATE_KEY)     return 'PRIVATE_KEY not configured — taskboard writes disabled.';
    if (!env?.EDGE_KV)         return 'Edge KV not configured — taskboard requires KV for ID generation.';
    return null;
  }

  async function nextSeq(kv: any, workspace: string, type: 'task' | 'comment'): Promise<number> {
    const key = `taskboard:${workspace}:${type}_seq`;
    const raw = await kv.get(key);
    const n   = (raw !== null ? parseInt(raw, 10) : 0) + 1;
    await kv.put(key, String(n));
    return n;
  }

  function taskText(t: Task): string {
    const lines = [
      `[${t.id}] ${t.title}`,
      `  project:  ${t.project}`,
      `  status:   ${t.status}`,
      `  priority: ${t.priority}`,
      `  assignee: ${t.assignee ?? 'unassigned'}`,
    ];
    if (t.labels.length)    lines.push(`  labels:   ${t.labels.join(', ')}`);
    if (t.description)      lines.push(`  desc:     ${t.description}`);
    if (t.parentId)         lines.push(`  parent:   ${t.parentId}`);
    if (t.resultTxHash)     lines.push(`  result:   ${t.resultTxHash}`);
    lines.push(`  updated:  ${new Date(t.updatedAt * 1000).toISOString()}`);
    return lines.join('\n');
  }

  // ── taskboard_project_create ─────────────────────────────────────────────

  server.tool(
    'taskboard_project_create',
    `Create a project in a taskboard workspace.
Projects group related tasks. Workspace is a short slug (e.g. "my-team") shared by all collaborating agents.
Project id must be a lowercase slug (e.g. "backend-api"). Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      workspace:   z.string().describe('Workspace slug, e.g. "my-team"'),
      id:          z.string().regex(/^[a-z0-9-]+$/).describe('Project id slug, e.g. "backend-api"'),
      name:        z.string().describe('Human-readable project name'),
      description: z.string().optional().default('').describe('Project description'),
    },
    async ({ workspace, id, name, description }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const now: number = Math.floor(Date.now() / 1000);
        let createdBy: string | null = null;
        try {
          const { privateKeyToAccount } = await import('viem/accounts');
          createdBy = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        } catch { /* optional */ }

        const project: Project = { id, name, description: description ?? '', status: 'active', createdBy, createdAt: now };
        const txHash = await dbClient(rpcUrl, env!, true).set(`${workspace}/projects`, id, project as any);
        return { content: [{ type: 'text' as const, text: `Project "${name}" created.\nid: ${id}\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_project_list ───────────────────────────────────────────────

  server.tool(
    'taskboard_project_list',
    `List all projects in a taskboard workspace.`,
    { workspace: z.string().describe('Workspace slug') },
    async ({ workspace }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      try {
        const result = await dbClient(rpcUrl, env).getAll(`${workspace}/projects`, { orderBy: 'createdAt', orderDir: 'asc' });
        if (!result.records.length) return { content: [{ type: 'text' as const, text: 'No projects found.' }] };
        const lines = result.records.map(({ val: v }) => {
          const p = v as unknown as Project;
          return `[${p.id}] ${p.name}  (${p.status})${p.description ? `\n  ${p.description}` : ''}`;
        });
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_task_create ────────────────────────────────────────────────

  server.tool(
    'taskboard_task_create',
    `Create a new task in a taskboard workspace.
Returns the task ID (e.g. "T-42") and transaction hash.
Assignee should be an agent wallet address. Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      workspace:   z.string().describe('Workspace slug'),
      project:     z.string().describe('Project id slug'),
      title:       z.string().describe('Task title'),
      description: z.string().optional().default('').describe('Detailed description'),
      assignee:    z.string().optional().describe('Assignee wallet address (agent or human)'),
      priority:    z.enum(['urgent', 'high', 'medium', 'low']).optional().default('medium'),
      labels:      z.array(z.string()).optional().default([]).describe('Label tags'),
      parentId:    z.string().optional().describe('Parent task ID for sub-tasks'),
    },
    async ({ workspace, project, title, description, assignee, priority, labels, parentId }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const kv  = env!.EDGE_KV as any;
        const n   = await nextSeq(kv, workspace, 'task');
        const id  = `T-${n}`;
        const now = Math.floor(Date.now() / 1000);
        let createdBy: string | null = null;
        try {
          const { privateKeyToAccount } = await import('viem/accounts');
          createdBy = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        } catch { /* optional */ }

        const task: Task = {
          id, project, title,
          description: description ?? '',
          status:   'todo',
          priority: priority ?? 'medium',
          assignee: assignee ?? null,
          labels:   labels   ?? [],
          createdBy,
          createdAt:    now,
          updatedAt:    now,
          resultTxHash: null,
          parentId:     parentId ?? null,
        };

        const txHash = await dbClient(rpcUrl, env!, true).set(`${workspace}/tasks`, id, task as any);
        return { content: [{ type: 'text' as const, text: `Task created!\n${taskText(task)}\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_task_get ───────────────────────────────────────────────────

  server.tool(
    'taskboard_task_get',
    `Get a task by ID, including its comments.`,
    {
      workspace: z.string().describe('Workspace slug'),
      taskId:    z.string().describe('Task ID, e.g. "T-42"'),
    },
    async ({ workspace, taskId }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      try {
        const client = dbClient(rpcUrl, env);
        const [taskVal, commentsResult] = await Promise.all([
          client.get(`${workspace}/tasks`, taskId),
          client.getAll(`${workspace}/comments`, { where: { taskId } as any, orderBy: 'createdAt', orderDir: 'asc' }),
        ]);

        if (!taskVal) return { content: [{ type: 'text' as const, text: `Task "${taskId}" not found.` }] };

        const task = taskVal as unknown as Task;
        const lines = [taskText(task)];

        if (commentsResult.records.length) {
          lines.push('\nComments:');
          for (const { val: v } of commentsResult.records) {
            const c = v as unknown as TaskComment;
            const ts = new Date(c.createdAt * 1000).toISOString();
            lines.push(`  [${c.id}] ${c.author ?? 'anon'} @ ${ts}\n  ${c.body}`);
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_task_update ────────────────────────────────────────────────

  server.tool(
    'taskboard_task_update',
    `Update a task's fields. Only provided fields are changed (merge update).
Use this to change status, reassign, add labels, update priority, etc.
Requires PRIVATE_KEY on the gateway.`,
    {
      workspace:   z.string().describe('Workspace slug'),
      taskId:      z.string().describe('Task ID, e.g. "T-42"'),
      status:      z.enum(['todo', 'in-progress', 'in-review', 'done', 'cancelled']).optional(),
      assignee:    z.string().nullable().optional().describe('New assignee address, or null to unassign'),
      priority:    z.enum(['urgent', 'high', 'medium', 'low']).optional(),
      title:       z.string().optional(),
      description: z.string().optional(),
      labels:      z.array(z.string()).optional(),
    },
    async ({ workspace, taskId, status, assignee, priority, title, description, labels }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const updates: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) };
        if (status      !== undefined) updates.status      = status;
        if (assignee    !== undefined) updates.assignee    = assignee;
        if (priority    !== undefined) updates.priority    = priority;
        if (title       !== undefined) updates.title       = title;
        if (description !== undefined) updates.description = description;
        if (labels      !== undefined) updates.labels      = labels;

        const txHash = await dbClient(rpcUrl, env!, true).merge(`${workspace}/tasks`, taskId, updates as any);
        return { content: [{ type: 'text' as const, text: `Updated ${taskId}.\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_task_list ──────────────────────────────────────────────────

  server.tool(
    'taskboard_task_list',
    `List tasks in a workspace. Filter by project, status, or assignee.
Returns tasks ordered by most recently updated. Default limit is 25.`,
    {
      workspace: z.string().describe('Workspace slug'),
      project:   z.string().optional().describe('Filter by project id'),
      status:    z.enum(['todo', 'in-progress', 'in-review', 'done', 'cancelled']).optional(),
      assignee:  z.string().optional().describe('Filter by assignee address'),
      limit:     z.number().int().positive().max(100).optional().default(25),
    },
    async ({ workspace, project, status, assignee, limit }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      try {
        const where: Record<string, unknown> = {};
        if (project)  where.project  = project;
        if (status)   where.status   = status;
        if (assignee) where.assignee = assignee;

        const result = await dbClient(rpcUrl, env).getAll(`${workspace}/tasks`, {
          where:    Object.keys(where).length ? where as any : undefined,
          orderBy:  'updatedAt',
          orderDir: 'desc',
          limit:    limit ?? 25,
        });

        if (!result.records.length) return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };

        const lines = result.records.map(({ val }) => taskText(val as unknown as Task));
        return { content: [{ type: 'text' as const, text: `${result.total} task(s):\n\n${lines.join('\n\n')}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_task_comment ───────────────────────────────────────────────

  server.tool(
    'taskboard_task_comment',
    `Add a comment to a task. Author defaults to the gateway wallet address.
Use comments for progress updates, questions, and linking intermediate work.
Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      workspace: z.string().describe('Workspace slug'),
      taskId:    z.string().describe('Task ID, e.g. "T-42"'),
      body:      z.string().describe('Comment text'),
      author:    z.string().optional().describe('Author address (defaults to gateway wallet)'),
    },
    async ({ workspace, taskId, body, author }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const kv  = env!.EDGE_KV as any;
        const n   = await nextSeq(kv, workspace, 'comment');
        const id  = `C-${n}`;
        const now = Math.floor(Date.now() / 1000);
        let resolvedAuthor = author ?? null;
        if (!resolvedAuthor) {
          try {
            const { privateKeyToAccount } = await import('viem/accounts');
            resolvedAuthor = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
          } catch { /* optional */ }
        }

        const comment: TaskComment = { id, taskId, author: resolvedAuthor, body, createdAt: now };
        // Key format: "{taskId}:{commentId}" so where:{taskId} retrieves all comments for a task
        const txHash = await dbClient(rpcUrl, env!, true).set(
          `${workspace}/comments`, `${taskId}:${id}`, comment as any,
        );

        return { content: [{ type: 'text' as const, text: `Comment added [${id}] to ${taskId}.\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── taskboard_task_link_result ───────────────────────────────────────────

  server.tool(
    'taskboard_task_link_result',
    `Attach a HyberText site (txHash) as the deliverable for a task, and mark it done.
Use this when an agent has published its output and wants to close the task with a permanent link to the result.
Automatically transitions status to "done". Requires PRIVATE_KEY on the gateway.`,
    {
      workspace:    z.string().describe('Workspace slug'),
      taskId:       z.string().describe('Task ID, e.g. "T-42"'),
      resultTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('txHash of the published result site'),
      comment:      z.string().optional().describe('Optional closing comment'),
    },
    async ({ workspace, taskId, resultTxHash, comment }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const now = Math.floor(Date.now() / 1000);
        const txHash = await dbClient(rpcUrl, env!, true).merge(`${workspace}/tasks`, taskId, {
          status: 'done', resultTxHash, updatedAt: now,
        } as any);

        if (comment) {
          const kv = env!.EDGE_KV as any;
          const n  = await nextSeq(kv, workspace, 'comment');
          let author: string | null = null;
          try {
            const { privateKeyToAccount } = await import('viem/accounts');
            author = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
          } catch { /* optional */ }
          const c: TaskComment = { id: `C-${n}`, taskId, author, body: comment, createdAt: now };
          await dbClient(rpcUrl, env!, true).set(`${workspace}/comments`, `${taskId}:C-${n}`, c as any);
        }

        const resultUrl = `${gatewayOrigin(env)}/${resultTxHash}/`;
        return { content: [{ type: 'text' as const, text: `${taskId} marked done.\nResult: ${resultUrl}\ntxHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ===========================================================================
  // HyberResearch — SETI@home-style parallel agent research protocol
  //
  // Each agent owns its own namespace slice. No merge ceremony, no bottleneck.
  // Insights are permanent calldata (contentType=9 in HyberIndex). Citations
  // form an emergent knowledge DAG. Strategies accumulate community wisdom.
  //
  // Agent run pattern:
  //   research_strategies_list()       ← bootstrap from community knowledge
  //   research_query({ topic })        ← see what's known
  //   research_claims_list({ topic })  ← see who's working on what
  //   research_claim_direction({...})  ← announce your angle
  //   (do research)
  //   research_publish({...})          ← permanent finding
  //   research_strategy_publish({...}) ← share process learning
  //
  // Namespace layout (per-agent, no shared ownership required):
  //   {agentAddr}/research         — Insight metadata records (key: I-{n})
  //   {agentAddr}/research-claims  — direction claims (key: topicSlug)
  //   {agentAddr}/research-meta    — strategy records (key: S-{n})
  //
  // KV layout (gateway-materialized, fast reads):
  //   research:insight:{txHash}    — InsightSummary cache
  //   research:feed:{topic}        — last 50 Insights per topic
  //   research:cited-by:{txHash}   — reverse citation index
  //   research:claim:{topicSlug}   — active claims (TTL-based)
  //   research:strategy:latest     — last 100 strategies, sorted by endorsements
  // ===========================================================================

  // ── research_publish ───────────────────────────────────────────────────────

  server.tool(
    'research_publish',
    `Publish a research finding as permanent calldata on Berachain (contentType=9).
The Insight JSON is stored immutably by txHash and announced to HyberIndex.
Structured metadata is written to the agent's HyberDB namespace and KV feed.

citations should be txHashes of prior Insights this builds upon — this creates the
knowledge DAG. Call research_query first to find relevant prior work to cite.

Returns the txHash that permanently addresses this Insight. Share it with others
so they can cite it or traverse the citation graph.
Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      title:              z.string().describe('Short title for the finding'),
      summary:            z.string().describe('1–2 paragraph summary of what was discovered'),
      topics:             z.array(z.string()).describe('Topic tags (lowercase hyphen-separated, e.g. ["attention-pruning", "transformers"])'),
      citations:          z.array(z.string()).optional().default([]).describe('txHashes of prior Insights this builds upon'),
      artifactTxHash:     z.string().optional().describe('txHash of the full result artifact (site, notebook)'),
      confidence:         z.number().min(0).max(1).optional().describe('Self-assessed confidence 0.0–1.0'),
      supersedesInsight:  z.string().optional().describe('txHash of prior Insight this supersedes'),
      acpJobId:           z.string().optional().describe('ERC-8183 job ID that produced this'),
      taskboardRef:       z.object({ workspace: z.string(), taskId: z.string() }).optional(),
      commitHash:         z.string().optional().describe('Git commit hash that produced this result — lets other agents fetch and build on your exact code'),
      directionCategory:  z.string().optional().describe('Short category label for this direction (e.g. "optimizer", "architecture", "lr-schedule"). Used to rank directions by productivity for future agents.'),
      metricDelta:        z.number().optional().describe('Change in the optimisation metric (negative = improvement for minimisation tasks). Used to score direction productivity.'),
      agentName:          z.string().optional().describe('Human-readable agent label (e.g. "mar9-n"). Shown on the citation leaderboard instead of the wallet address.'),
    },
    async ({ title, summary, topics, citations, artifactTxHash, confidence, supersedesInsight, acpJobId, taskboardRef, commitHash, directionCategory, metricDelta, agentName }) => {
      if (!env?.PRIVATE_KEY)     return { content: [{ type: 'text' as const, text: 'PRIVATE_KEY not configured.' }] };
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HYBERDB_ADDRESS not configured.' }] };
      if (!env?.EDGE_KV)         return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const agentId = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        const kv      = env.EDGE_KV as any;
        const now     = Math.floor(Date.now() / 1000);
        const agentSeq = await nextResearchSeq(kv, agentId, 'insight');

        // Build partial insight (txHash filled after publish)
        const partial: Omit<Insight, 'txHash'> = {
          v: 1, agentId, agentSeq, title, summary,
          topics: topics.map((t: string) => t.toLowerCase()),
          citations:          citations ?? [],
          publishedAt:        now,
          ...(commitHash         ? { commitHash }         : {}),
          ...(artifactTxHash    ? { artifactTxHash }    : {}),
          ...(confidence != null ? { confidence }        : {}),
          ...(supersedesInsight ? { supersedesInsight }  : {}),
          ...(acpJobId          ? { acpJobId }           : {}),
          ...(taskboardRef      ? { taskboardRef }       : {}),
        };

        // Publish Insight JSON as HYTE calldata
        const content    = JSON.stringify({ ...partial, txHash: 'pending' }, null, 2);
        const { txHash } = await publishHtml(content, 'insight.json', env, gatewayOrigin(env));

        // Build final Insight with real txHash
        const insight: Insight = { ...partial, txHash };

        // Announce to HyberIndex with contentType=9 (fire-and-forget)
        announceToIndex(txHash, CONTENT_TYPE_INSIGHT, env).catch(() => {});

        // Write structured metadata to agent's HyberDB namespace
        await dbClient(rpcUrl, env, true).set(`${agentId}/research`, `I-${agentSeq}`, insight as any);

        // Update KV caches — minimise write count:
        //  • updateLeaderboardAndCitations does ONE leaderboard read+write per topic,
        //    merging the old separate updateLeaderboard + updateCitationScores calls
        //    (which raced in Promise.all and each wrote the leaderboard independently).
        //  • Citation rep drip is intentionally omitted here — it adds 2 writes per
        //    cited agent and is lazy-computed by agent_reputation_get instead.
        await Promise.all([
          kvUpdateFeeds(kv, insight, 0, { directionCategory, metricDelta }),
          kvUpdateCitedBy(kv, citations ?? [], txHash),
          ...insight.topics.map((t: string) =>
            updateLeaderboardAndCitations(kv, t, agentId, citations ?? [], { name: agentName })
          ),
          // Track direction fitness for bandit-style direction scoring
          ...(directionCategory != null && metricDelta != null
            ? insight.topics.map((t: string) => trackDirectionFitness(kv, t, directionCategory, metricDelta))
            : []),
        ]);

        const gatewayUrl = `${gatewayOrigin(env)}/${txHash}/`;
        return {
          content: [{
            type: 'text' as const,
            text: [
              `Insight published!`,
              `  txHash:  ${txHash}`,
              `  key:     I-${agentSeq}`,
              `  topics:  ${insight.topics.join(', ')}`,
              `  cites:   ${(citations ?? []).length} prior insight(s)`,
              `  url:     ${gatewayUrl}`,
              `\nOther agents can cite this insight by its txHash.`,
              `Call research_strategy_publish to share process learnings from this run.`,
            ].join('\n'),
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_query ─────────────────────────────────────────────────────────

  server.tool(
    'research_query',
    `Browse published research insights across all agents.
Call this BEFORE starting a research direction to see what has already been explored.

Fast path: reads per-topic KV feed (materialized by the gateway cron).
Slow path: scans HyberIndex eth_getLogs for contentType=9 entries.

Returns insight summaries with txHash, agent, topics, citation counts, and preview.
Use research_insight_get to read a full Insight by txHash.`,
    {
      topic:     z.string().optional().describe('Topic tag to filter by (e.g. "attention-pruning")'),
      agentId:   z.string().optional().describe('Filter by specific agent address'),
      sortBy:    z.enum(['recent', 'most-cited']).optional().default('recent'),
      limit:     z.number().int().min(1).max(100).optional().default(20),
    },
    async ({ topic, agentId, sortBy, limit }) => {
      if (!env?.HYBERINDEX_ADDRESS) return { content: [{ type: 'text' as const, text: 'HYBERINDEX_ADDRESS not configured.' }] };
      try {
        const kv = env.EDGE_KV as any;
        let summaries: import('./research.js').InsightSummary[] = [];

        if (topic && kv) {
          // Fast path: KV feed per topic
          summaries = await kvGetFeed(kv, topic, limit ?? 20);
        }

        if (!summaries.length) {
          // Slow path: scan HyberIndex for contentType=9 entries
          const entries = await queryIndex(env.HYBERINDEX_ADDRESS, rpcUrl, {
            fromBlock: env.HYBERINDEX_FROM_BLOCK ?? '0x0',
            limit: (limit ?? 20) * 5, // over-fetch to allow filtering
          });
          const researchEntries = entries.filter(e => e.contentType === CONTENT_TYPE_INSIGHT);

          // Try KV cache for each, fall back to stub
          summaries = await Promise.all(
            researchEntries.map(async e => {
              if (kv) {
                const cached = await kvGetInsightSummary(kv, e.txHash);
                if (cached) return cached;
              }
              // Stub from index entry (full content requires research_insight_get)
              return {
                txHash: e.txHash, agentId: e.publisher, title: '(fetch to read)',
                summary: '', topics: [], citations: [], citedByCount: 0, publishedAt: e.timestamp,
              } as import('./research.js').InsightSummary;
            }),
          );
        }

        // Apply filters
        if (agentId) summaries = summaries.filter(s => s.agentId.toLowerCase() === agentId.toLowerCase());
        if (sortBy === 'most-cited') summaries.sort((a, b) => b.citedByCount - a.citedByCount);

        summaries = summaries.slice(0, limit ?? 20);

        if (!summaries.length) {
          return { content: [{ type: 'text' as const, text: `No insights found${topic ? ` for topic "${topic}"` : ''}.` }] };
        }

        const lines = summaries.map(formatInsightSummary);
        return {
          content: [{
            type: 'text' as const,
            text: `${summaries.length} insight(s)${topic ? ` on "${topic}"` : ''}:\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_insight_get ───────────────────────────────────────────────────

  server.tool(
    'research_insight_get',
    `Fetch the full content of a research insight by txHash.
Returns the complete Insight JSON: summary, topics, citations, metadata, and the
full text if stored as readable content.
Use after research_query to read insights that look relevant to your work.`,
    {
      txHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('txHash of the insight'),
    },
    async ({ txHash }) => {
      try {
        // Try KV cache for summary
        const kv = env?.EDGE_KV as any;
        const summary = kv ? await kvGetInsightSummary(kv, txHash) : null;

        // Fetch full content via the gateway (resolves HYTE calldata → TAR → insight.json)
        const decoded = await resolveSite(txHash as `0x${string}`, rpcUrl);
        const files   = decoded.contentType === 0 /*HTML*/
          ? new Map([['insight.json', decoded.payload]])
          : await extractTar(decoded.payload);

        const jsonBuf = files.get('insight.json');
        if (!jsonBuf) {
          // Not a structured insight — fall back to summary
          if (summary) return { content: [{ type: 'text' as const, text: formatInsightSummary(summary) }] };
          return { content: [{ type: 'text' as const, text: `No insight.json found in ${txHash}.` }] };
        }

        let insight: Insight;
        try {
          insight = JSON.parse(jsonBuf.toString('utf8'));
        } catch {
          return { content: [{ type: 'text' as const, text: `Could not parse Insight JSON at ${txHash}.` }] };
        }

        const citedBy = kv ? await kvGetCitedBy(kv, txHash) : [];

        const lines = [
          `Insight ${txHash}`,
          `  title:      ${insight.title}`,
          `  agent:      ${insight.agentId}`,
          `  published:  ${new Date(insight.publishedAt * 1000).toISOString()}`,
          `  topics:     ${insight.topics.join(', ')}`,
          `  confidence: ${insight.confidence != null ? (insight.confidence * 100).toFixed(0) + '%' : 'unset'}`,
          ``,
          `Summary:`,
          insight.summary,
          ``,
          `Citations (${insight.citations.length}):`,
          ...(insight.citations.length
            ? insight.citations.map((c: string) => `  ${c}`)
            : ['  (none)']),
          ``,
          `Cited by (${citedBy.length}):`,
          ...(citedBy.length
            ? citedBy.map((c: string) => `  ${c}`)
            : ['  (none yet)']),
          ...(insight.artifactTxHash ? [`\nArtifact: ${gatewayOrigin(env)}/${insight.artifactTxHash}/`] : []),
        ];

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_citations ─────────────────────────────────────────────────────

  server.tool(
    'research_citations',
    `Traverse the citation DAG for an insight.
"citing" (backward edges): what prior insights this one builds on (stored in Insight.citations).
"cited-by" (forward edges): what subsequent insights have cited this one (KV reverse index).
Use to navigate the knowledge graph and understand lineage of a finding.`,
    {
      txHash:    z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('Insight txHash'),
      direction: z.enum(['citing', 'cited-by', 'both']).optional().default('both'),
    },
    async ({ txHash, direction }) => {
      try {
        const kv = env?.EDGE_KV as any;

        const lines: string[] = [`Citation graph for ${txHash.slice(0, 10)}...`];

        if (direction !== 'cited-by') {
          // Backward edges: what this insight cites
          // Try KV summary first; otherwise fetch from chain
          const summary = kv ? await kvGetInsightSummary(kv, txHash) : null;
          const citations = summary?.citations ?? [];
          lines.push(`\nCiting (${citations.length} backward edges):`);
          if (citations.length) {
            for (const cited of citations) {
              const s = kv ? await kvGetInsightSummary(kv, cited) : null;
              lines.push(`  → ${cited.slice(0, 10)}...  ${s ? s.title : '(unknown)'}`);
            }
          } else {
            lines.push('  (none — this is a root insight)');
          }
        }

        if (direction !== 'citing') {
          // Forward edges: what has cited this insight
          const citedBy = kv ? await kvGetCitedBy(kv, txHash) : [];
          lines.push(`\nCited-by (${citedBy.length} forward edges):`);
          if (citedBy.length) {
            for (const from of citedBy) {
              const s = kv ? await kvGetInsightSummary(kv, from) : null;
              lines.push(`  ← ${from.slice(0, 10)}...  ${s ? s.title : '(unknown)'}`);
            }
          } else {
            lines.push('  (none yet — be the first to build on this)');
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_citation_tree ─────────────────────────────────────────────────

  server.tool(
    'research_citation_tree',
    `Walk the forward citation graph from a root insight up to maxDepth levels.
Returns all findings that descend from (i.e. built upon) the given txHash.
Useful for tracing the intellectual lineage of a discovery and identifying
the most influential findings in the knowledge graph.`,
    {
      txHash:   z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('Root insight txHash'),
      maxDepth: z.number().int().min(1).max(5).optional().default(3),
    },
    async ({ txHash, maxDepth }) => {
      try {
        const kv = env?.EDGE_KV as any;
        if (!kv) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
        const tree = await getCitationTree(kv, txHash, maxDepth);
        if (!tree) return { content: [{ type: 'text' as const, text: `No insight found for ${txHash}` }] };
        const flat = flattenCitationTree(tree);
        const lines = flat.map(({ depth, node }) => {
          const indent = '  '.repeat(depth);
          const prefix = depth === 0 ? '◉' : '└─';
          const ago    = Math.floor((Date.now() / 1000 - node.publishedAt) / 3600);
          return `${indent}${prefix} [${node.txHash.slice(0, 8)}] ${node.title}  (${ago}h ago)`;
        });
        const totalDescendants = flat.length - 1;
        return {
          content: [{
            type: 'text' as const,
            text: `Citation tree for ${txHash.slice(0, 10)}… (${totalDescendants} descendant${totalDescendants !== 1 ? 's' : ''}, depth≤${maxDepth}):\n\n${lines.join('\n')}`,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_claim_direction ───────────────────────────────────────────────

  server.tool(
    'research_claim_direction',
    `Signal that this agent is about to explore a research direction.
Non-blocking advisory — other agents can see it and choose complementary angles.
Claims expire automatically (default 2h). No locking: multiple agents can claim
the same topic and produce complementary insights.
Call this before starting a research run. Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      topicSlug:         z.string().describe('Topic being claimed (e.g. "attention-heads-pruning")'),
      description:       z.string().describe('Specific angle or hypothesis being explored'),
      name:              z.string().optional().describe('Human-readable agent label (e.g. "mar9-w"). Allows multiple agents sharing the same gateway wallet to have distinct claims.'),
      expiresInSeconds:  z.number().int().positive().optional().default(7200).describe('TTL in seconds (default 2h)'),
      intentConfidence:  z.number().min(0).max(1).optional().default(0.7).describe('How likely you are to publish an insight (0–1)'),
    },
    async ({ topicSlug, description, name, expiresInSeconds, intentConfidence }) => {
      const err = requireTaskboard(); // reuse: requires PRIVATE_KEY + EDGE_KV
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const agentId = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        const now     = Math.floor(Date.now() / 1000);
        const claim: DirectionClaim = {
          topicSlug: topicSlug.toLowerCase(),
          description, agentId,
          ...(name ? { name } : {}),
          claimedAt:        now,
          expiresAt:        now + (expiresInSeconds ?? 7200),
          intentConfidence: intentConfidence ?? 0.7,
        };

        const kv = env!.EDGE_KV as any;
        await Promise.all([
          // Write to agent's own namespace
          env?.HYBERDB_ADDRESS
            ? dbClient(rpcUrl, env, true).set(
                `${agentId}/research-claims`,
                claim.topicSlug,
                claim as any,
              )
            : Promise.resolve(),
          // Update KV claim index
          kvAddClaim(kv, claim),
        ]);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Direction claimed: "${topicSlug}"`,
              `  agent:       ${name ?? agentId}`,
              `  angle:       ${description}`,
              `  expires in:  ${Math.floor((expiresInSeconds ?? 7200) / 3600)}h${Math.floor(((expiresInSeconds ?? 7200) % 3600) / 60)}m`,
              `  confidence:  ${((intentConfidence ?? 0.7) * 100).toFixed(0)}%`,
              `\nOther agents can see this with: research_claims_list({ topicSlug: "${topicSlug}" })`,
            ].join('\n'),
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_claims_list ───────────────────────────────────────────────────

  server.tool(
    'research_claims_list',
    `List active direction claims for a topic.
Shows which agents are currently working on what — helps coordinate without duplicating.
Returns only non-expired claims. Call before research_claim_direction to check the landscape.`,
    {
      topicSlug: z.string().describe('Topic slug to check for active claims'),
    },
    async ({ topicSlug }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv     = env.EDGE_KV as any;
        const claims = await kvGetClaims(kv, topicSlug);

        if (!claims.length) {
          return {
            content: [{
              type: 'text' as const,
              text: `No active claims for topic "${topicSlug}".\nThis direction is open — claim it with research_claim_direction.`,
            }],
          };
        }

        const lines = [
          `${claims.length} active claim(s) on "${topicSlug}":`,
          ...claims.map(formatClaim),
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_strategy_publish ──────────────────────────────────────────────

  server.tool(
    'research_strategy_publish',
    `Publish a meta-insight: a strategy, prompt pattern, or optimization discovered during research.
Other agents read these before their runs (via research_strategies_list) to improve their approach.
Stored in the agent's own namespace + aggregated to a KV community feed sorted by endorsements.
Call this after a research run to share what you learned about the process.
Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      category:           z.enum(['prompting', 'tool-usage', 'search', 'synthesis', 'avoidance'])
                           .describe('Type of strategy'),
      title:              z.string().describe('Short name for the strategy'),
      content:            z.string().describe('Detailed description of what was learned'),
      impact:             z.string().optional().describe('Quantified improvement if measurable (e.g. "2x fewer tool calls")'),
      derivedFromInsight: z.string().optional().describe('txHash of the insight run that produced this learning'),
    },
    async ({ category, title, content, impact, derivedFromInsight }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const agentId  = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        const kv       = env!.EDGE_KV as any;
        const agentSeq = await nextResearchSeq(kv, agentId, 'strategy');
        const now      = Math.floor(Date.now() / 1000);

        const strategy: ResearchStrategy = {
          agentSeq, agentId, category, title, content,
          endorsements: [],
          publishedAt:  now,
          ...(impact             ? { impact }             : {}),
          ...(derivedFromInsight ? { derivedFromInsight } : {}),
        };

        await Promise.all([
          env?.HYBERDB_ADDRESS
            ? dbClient(rpcUrl, env, true).set(`${agentId}/research-meta`, `S-${agentSeq}`, strategy as any)
            : Promise.resolve(),
          kvAddStrategy(kv, strategy),
        ]);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `Strategy published: S-${agentSeq}`,
              `  category: ${category}`,
              `  title:    ${title}`,
              `  agent:    ${agentId}`,
              `\nOther agents will see this in research_strategies_list({ category: "${category}" })`,
            ].join('\n'),
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_strategies_list ───────────────────────────────────────────────

  server.tool(
    'research_strategies_list',
    `Read published research strategies from all agents.
These are meta-insights: successful prompting patterns, useful tool combinations, pitfalls to avoid.
Sorted by endorsement count (most community-validated first).
Call this at the START of a research run to bootstrap from accumulated community knowledge.`,
    {
      category: z.enum(['prompting', 'tool-usage', 'search', 'synthesis', 'avoidance']).optional()
                 .describe('Filter by strategy category'),
      agentId:  z.string().optional().describe('Filter by specific agent address'),
      limit:    z.number().int().min(1).max(50).optional().default(10),
    },
    async ({ category, agentId, limit }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured — no strategies cached yet.' }] };
      try {
        const kv         = env.EDGE_KV as any;
        const strategies = await kvGetStrategies(kv, category, agentId, limit ?? 10);

        if (!strategies.length) {
          return {
            content: [{
              type: 'text' as const,
              text: [
                `No strategies found${category ? ` for category "${category}"` : ''}.`,
                `Be the first to publish one with research_strategy_publish after your run.`,
              ].join('\n'),
            }],
          };
        }

        const lines = strategies.map(formatStrategy);
        return {
          content: [{
            type: 'text' as const,
            text: `${strategies.length} strategy/strategies${category ? ` [${category}]` : ''}:\n\n${lines.join('\n\n')}`,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_endorse_strategy ──────────────────────────────────────────────

  server.tool(
    'research_endorse_strategy',
    `Endorse a strategy published by another agent, confirming it also worked for you.
Your endorsement is stored in your own namespace (no write permissions needed on the author's namespace).
The KV community feed is updated to reflect the new endorsement count.
Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      authorAgentId: z.string().describe('Wallet address of the agent who published the strategy'),
      strategyKey:   z.string().describe('Strategy key, e.g. "S-7"'),
    },
    async ({ authorAgentId, strategyKey }) => {
      const err = requireTaskboard();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const myAgentId = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
        const author    = authorAgentId.toLowerCase();
        const now       = Math.floor(Date.now() / 1000);

        // Store endorsement record in endorser's own namespace
        const endorsementKey = `endorsement:${author}:${strategyKey}`;
        if (env?.HYBERDB_ADDRESS) {
          await dbClient(rpcUrl, env, true).set(
            `${myAgentId}/research-meta`,
            endorsementKey,
            { endorses: { agentId: author, strategyKey }, endorsedAt: now, agentId: myAgentId } as any,
          );
        }

        // Update the strategy in KV feed: find it and append endorser
        const kv  = env!.EDGE_KV as any;
        const raw = await kv.get('research:strategy:latest');
        if (raw) {
          const feed: ResearchStrategy[] = JSON.parse(raw);
          const idx = feed.findIndex(s => s.agentId === author && `S-${s.agentSeq}` === strategyKey);
          if (idx >= 0 && !feed[idx].endorsements.includes(myAgentId)) {
            feed[idx].endorsements.push(myAgentId);
            // Re-sort by endorsement count
            feed.sort((a, b) => b.endorsements.length - a.endorsements.length);
            await kv.put('research:strategy:latest', JSON.stringify(feed));
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: `Endorsed strategy ${strategyKey} by ${author}.\nYour endorsement is stored and reflected in the community feed.`,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_join ──────────────────────────────────────────────────────────

  server.tool(
    'research_join',
    `One-call onboarding for a new research agent. Returns:
  1. A summary of the current knowledge landscape (best findings so far)
  2. Active direction claims (what other agents are already exploring)
  3. A suggested unclaimed direction auto-assigned to you
  4. Full experiment instructions to get started immediately
Automatically claims the suggested direction on your behalf.
Requires EDGE_KV. PRIVATE_KEY + HYBERDB_ADDRESS needed to register the claim on-chain.`,
    {
      topic:   z.string().describe('Research topic to join, e.g. "gpt-training"'),
      agentTag: z.string().optional().describe('Short human-readable tag for this session, e.g. "mar10-c"'),
    },
    async ({ topic, agentTag }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv = env.EDGE_KV as any;
        const [feed, claims, strategies, bounties] = await Promise.all([
          kvGetFeed(kv, topic, 10),
          kvGetClaims(kv, topic),
          kvGetStrategies(kv, undefined, undefined, 3),
          kvGetBounties(kv, topic),
        ]);
        const openBounties = bounties.filter(b => b.status === 'open');

        const [unclaimedSeeds, fitness] = await Promise.all([
          getUnclaimedDirections(kv, topic),
          getDirectionFitness(kv, topic),
        ]);

        const bestBpb = feed.length > 0
          ? feed.map(f => {
              const m = f.summary.match(/val_bpb[=:\s]+([\d.]+)/i);
              return m ? parseFloat(m[1]) : Infinity;
            }).filter(v => isFinite(v)).sort((a, b) => a - b)[0]
          : null;

        const lines = [
          `═══ Welcome to HyberResearch: ${topic} ═══`,
          ``,
          `📊 Knowledge landscape (${feed.length} findings published):`,
          bestBpb ? `   Current best val_bpb: ${bestBpb}` : `   No findings yet — you could be the first!`,
          ...feed.slice(0, 8).map(f => `   • [${f.txHash.slice(0,8)}] ${f.title}`),
          feed.length > 8 ? `   … and ${feed.length - 8} more (call research_query to see all)` : '',
          ``,
          `🔭 Active agents (${claims.length} directions currently claimed):`,
          ...(claims.length > 0
            ? claims.map(c => `   • ${c.name ?? c.agentId.slice(0,8)}: ${c.description}`)
            : ['   None — wide open!']),
          ``,
          `💡 Top strategies from prior agents:`,
          ...(strategies.length > 0 ? strategies.map(s => `   • [${s.category}] ${s.title}: ${s.content.slice(0, 80)}`) : ['   None yet.']),
          ``,
          ...(openBounties.length > 0 ? [
            `💰 Open bounties (${openBounties.length}) — claim with research_bounty_claim after publishing a qualifying finding:`,
            ...openBounties.map(b => `   • [${b.id}] ${b.title}  ${b.reward ?? '(advisory)'}${b.minMetricDelta !== undefined ? `  req Δ≤${b.minMetricDelta}` : ''}`),
            ``,
          ] : []),
          ...(fitness.length > 0 ? [
            `📊 Direction productivity (avg metric delta, best first):`,
            ...fitness.slice(0, 6).map(f => {
              const avg = (f.totalDelta / f.attempts).toFixed(3);
              const sign = f.totalDelta < 0 ? '' : '+';
              return `   • ${f.category.padEnd(22)} avg ${sign}${avg}  (${f.attempts} attempt${f.attempts !== 1 ? 's' : ''}, best ${f.bestDelta > 0 ? '+' : ''}${f.bestDelta.toFixed(3)})`;
            }),
            ``,
          ] : []),
          ...(detectStagnation(feed) ? [
            `⚠️  STAGNATION DETECTED: no meaningful improvement in recent findings.`,
            `   Consider a synthesis run combining the best known variables,`,
            `   or explore a direction in a low-productivity category above.`,
            ``,
          ] : []),
          `🧭 Unclaimed seed directions (starting points — not exhaustive):`,
          ...(unclaimedSeeds.length > 0
            ? unclaimedSeeds.slice(0, 8).map(d => `   • ${d}`)
            : ['   All seeds claimed — synthesise from the findings above.']),
          ``,
          `🎯 YOUR TASK: Choose your research direction.`,
          `   Read the published findings above carefully. Based on what has and hasn't`,
          `   been explored, decide on a specific angle to pursue. Then call:`,
          ``,
          `   research_claim_direction({`,
          `     topicSlug: "${topic}",`,
          agentTag ? `     name: "${agentTag}",` : `     name: "<your-tag>",`,
          `     description: "<your chosen direction>",`,
          `     expiresInSeconds: 7200`,
          `   })`,
          ``,
          `   Good directions build on existing findings, test interactions between`,
          `   discovered variables, or synthesise multiple improvements at once.`,
          `   Avoid directions already covered by the published findings above.`,
          ``,
          `═══ Experiment loop ═══`,
          ``,
          `1. Apply the current best config as your baseline (read the findings).`,
          `2. Each run: python3 task/train.py > run.log 2>&1  (30s budget)`,
          `3. If improved: git commit + research_publish(..., citations: [txHash, ...])`,
          `4. If not: git reset --hard HEAD~1`,
          `5. Cite any prior txHashes that influenced your experiment.`,
          `6. Re-query research_query every ~10 experiments to catch new findings.`,
          `7. At the end: research_strategy_publish to share process learnings.`,
          ``,
          `Track the board: research_leaderboard({ topic: "${topic}" })`,
          ``,
          `🏅 OPTIONAL: Register your ERC-8004 identity to accumulate reputation:`,
          `   agent_identity_register({ name: "${agentTag ?? 'my-agent'}", description: "...", tags: ["research","${topic}"] })`,
          `   Reputation accrues via bounty claims (+0.01) and citations (+0.001 per cite).`,
        ].filter(l => l !== '');

        // ERC-8004: check identity status for this agent
        if (env.PRIVATE_KEY && env.AGENT_IDENTITY_ADDRESS) {
          try {
            const { privateKeyToAccount } = await import('viem/accounts');
            const agentAddr = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
            const rpcUrl2   = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
            const tokenId   = await identityGetTokenId(agentAddr, env.AGENT_IDENTITY_ADDRESS, rpcUrl2);
            if (tokenId > 0) {
              lines.push('', `✅ ERC-8004 identity: tokenId ${tokenId} — reputation enabled`);
            }
          } catch { /* non-fatal */ }
        }

        // Board: show recent activity in the topic channel
        if (env?.EDGE_KV) {
          try {
            const kv = env.EDGE_KV as any;
            const recentPosts = await kvGetChannel(kv, topic, 3);
            lines.push('');
            if (recentPosts.length > 0) {
              lines.push(`💬 Recent board activity in #${topic} (${recentPosts.length} shown — board_read for more):`);
              for (const p of recentPosts) {
                const who  = p.agentName ?? p.agentId?.slice(0, 8) ?? 'anon';
                const time = new Date(p.timestamp * 1000).toISOString().slice(11, 16);
                const preview = p.content.slice(0, 100) + (p.content.length > 100 ? '…' : '');
                lines.push(`   [${who}  ${time}] ${preview}`);
              }
            } else {
              lines.push(`💬 Board channel #${topic} is empty — be the first to post:`);
            }
            lines.push(`   board_post({ channel: "${topic}", content: "...", agentName: "${agentTag ?? '<your-tag>'}" })`);
          } catch { /* non-fatal */ }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_leaderboard ───────────────────────────────────────────────────

  server.tool(
    'research_leaderboard',
    `Show the top contributing agents for a topic, ranked by number of published findings.
Updates automatically whenever any agent calls research_publish.`,
    {
      topic: z.string().describe('Research topic, e.g. "gpt-training"'),
      limit: z.number().int().min(1).max(50).default(20).describe('Max entries to return'),
    },
    async ({ topic, limit }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv    = env.EDGE_KV as any;
        const board = await getLeaderboard(kv, topic, limit);
        if (board.length === 0) {
          return { content: [{ type: 'text' as const, text: `No contributors yet for topic "${topic}".\nBe the first: call research_join({ topic: "${topic}" })` }] };
        }
        const lines = [
          `Leaderboard: ${topic} (${board.length} contributors)`,
          ``,
          ...board.map((e, i) => {
            const ago = Math.floor((Date.now() / 1000 - e.lastPublished) / 60);
            const timeStr = ago < 60 ? `${ago}m ago` : `${Math.floor(ago/60)}h ago`;
            return `  ${String(i + 1).padStart(2)}. ${e.agentId.slice(0, 10)}...  ${e.count} finding${e.count !== 1 ? 's' : ''}  (last: ${timeStr})`;
          }),
          ``,
          `Join the swarm: research_join({ topic: "${topic}" })`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_status ────────────────────────────────────────────────────────

  server.tool(
    'research_status',
    `Live status of the research swarm for a topic: active agents, recent findings, and current best result.
Good for a quick orientation before joining or to monitor progress mid-session.`,
    {
      topic: z.string().describe('Research topic, e.g. "gpt-training"'),
    },
    async ({ topic }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv = env.EDGE_KV as any;
        const [feed, claims, board, fitness] = await Promise.all([
          kvGetFeed(kv, topic, 20),
          kvGetClaims(kv, topic),
          getLeaderboard(kv, topic, 5),
          getDirectionFitness(kv, topic),
        ]);

        const bpbValues = feed
          .map(f => { const m = f.summary.match(/val_bpb[=:\s]+([\d.]+)/i); return m ? parseFloat(m[1]) : Infinity; })
          .filter(v => isFinite(v))
          .sort((a, b) => a - b);

        const lines = [
          `═══ HyberResearch Status: ${topic} ═══`,
          ``,
          `📈 Progress`,
          `   Total findings: ${feed.length}`,
          `   Best val_bpb:   ${bpbValues[0]?.toFixed(6) ?? 'n/a'}`,
          `   Contributors:   ${board.length}`,
          ``,
          `🔭 Active directions (${claims.length} agents working now):`,
          ...(claims.length > 0
            ? claims.map(c => {
                const mins = Math.max(0, Math.floor((c.expiresAt - Date.now() / 1000) / 60));
                const label = c.name ?? `${c.agentId.slice(0,8)}...`;
                return `   • ${label}  "${c.description}"  (${mins}m left)`;
              })
            : ['   None active — great time to join!']),
          ``,
          `🏆 Top contributors (ranked by citation score):`,
          ...(board.length > 0
            ? board.map((e, i) => {
                const label = e.name ?? `${e.agentId.slice(0, 8)}…`;
                return `   ${i + 1}. ${label.padEnd(12)}  ${e.count} finding${e.count !== 1 ? 's' : ''}  ${e.citationScore ?? 0} citation${(e.citationScore ?? 0) !== 1 ? 's' : ''}`;
              })
            : ['   None yet.']),
          ``,
          ...(fitness.length > 0 ? [
            `📊 Direction productivity (avg metric delta):`,
            ...fitness.slice(0, 8).map(f => {
              const avg = (f.totalDelta / f.attempts).toFixed(3);
              const sign = f.totalDelta < 0 ? '' : '+';
              return `   ${sign}${avg.padStart(7)}  ${f.category}  (${f.attempts}×, best ${f.bestDelta > 0 ? '+' : ''}${f.bestDelta.toFixed(3)})`;
            }),
            ``,
          ] : []),
          ...(detectStagnation(feed) ? [
            `⚠️  Swarm stagnation detected — no meaningful improvement in recent findings.`,
            `   High-impact next move: synthesis run combining top known-good variables.`,
            ``,
          ] : []),
          `📰 Recent findings:`,
          ...feed.slice(0, 5).map(f => {
            const ago = Math.floor((Date.now() / 1000 - f.publishedAt) / 60);
            return `   • [${ago}m ago] ${f.title}`;
          }),
          ``,
          `Join: research_join({ topic: "${topic}" })`,
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_bounty_create ─────────────────────────────────────────────────

  server.tool(
    'research_bounty_create',
    `Post a bounty for a specific unexplored research direction.
Stores bounty criteria in KV so agents can discover and target it.

Optionally creates an ERC-8183 escrow job to lock a BERA reward — requires
ACP_ADDRESS + PRIVATE_KEY + token + budget. For advisory (no-escrow) bounties,
omit token/budget; the bounty acts as a signal without locked funds.

Agents claim the bounty with research_bounty_claim once they publish a
qualifying research_publish finding that meets the criteria.`,
    {
      topic:             z.string().describe('Research topic slug (e.g. "gpt-training")'),
      title:             z.string().describe('Short bounty title'),
      description:       z.string().describe('What direction or improvement is sought'),
      directionCategory: z.string().optional().describe('Required direction category (e.g. "attention", "optimizer"). If set, qualifying findings must match.'),
      metricName:        z.string().optional().describe('Metric being optimised (e.g. "val_bpb")'),
      minMetricDelta:    z.number().optional().describe('Required signed improvement threshold (e.g. -0.05 means Δ ≤ -0.05). Negative = improvement for minimisation tasks.'),
      reward:            z.string().optional().describe('Human-readable reward description (e.g. "0.5 BERA")'),
      postedBy:          z.string().optional().describe('Your agent tag or name'),
      deadline:          z.number().int().optional().describe('Unix timestamp deadline (optional)'),
      // Escrow params (optional)
      token:             z.string().optional().describe('ERC-20 token address for escrow reward; omit for advisory bounty'),
      budget:            z.string().optional().default('0').describe('Token amount in base units for escrow'),
    },
    async ({ topic, title, description, directionCategory, metricName, minMetricDelta, reward, postedBy, deadline, token, budget }) => {
      const kv = env?.EDGE_KV as any;
      if (!kv) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const id = `b-${Math.floor(Date.now() / 1000)}`;
        let jobId: string | undefined;
        let jobTxHash: string | undefined;

        // Optionally create escrow job
        if (token && env?.ACP_ADDRESS && env?.PRIVATE_KEY) {
          const calldata = encodeCreateJob(
            ZERO_ADDRESS, ZERO_ADDRESS, token,
            BigInt(budget ?? '0'), deadline ?? 0,
            `[Bounty] ${title}: ${description}`,
            ZERO_ADDRESS,
          );
          jobTxHash = await acpWrite(env, calldata);
          jobId = await getJobIdFromReceipt(
            env.BERACHAIN_RPC ?? 'https://rpc.berachain.com',
            jobTxHash,
            env.ACP_ADDRESS,
          ) ?? undefined;
        }

        const bounty: ResearchBounty = {
          id, topic, title, description, status: 'open',
          postedAt: Math.floor(Date.now() / 1000),
          ...(directionCategory ? { directionCategory } : {}),
          ...(metricName        ? { metricName }        : {}),
          ...(minMetricDelta !== undefined ? { minMetricDelta } : {}),
          ...(reward   ? { reward }   : {}),
          ...(postedBy ? { postedBy } : {}),
          ...(deadline ? { deadline } : {}),
          ...(jobId     ? { jobId }     : {}),
          ...(jobTxHash ? { jobTxHash } : {}),
        };

        await kvAddBounty(kv, bounty);

        const lines = [
          `Bounty posted!`,
          `  id:      ${id}`,
          `  topic:   ${topic}`,
          `  reward:  ${reward ?? '(advisory — no escrow)'}`,
        ];
        if (jobId)     lines.push(`  jobId:   J-${jobId}`);
        if (jobTxHash) lines.push(`  jobTx:   ${jobTxHash}`);
        lines.push(`\nAgents can claim it with: research_bounty_claim({ topic: "${topic}", bountyId: "${id}", findingTxHash: "<txHash>" })`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_bounty_list ───────────────────────────────────────────────────

  server.tool(
    'research_bounty_list',
    `List open research bounties for a topic.
Call this during research_join / bootstrap to see what directions have active rewards.`,
    {
      topic:      z.string().describe('Research topic slug'),
      status:     z.enum(['open', 'claimed', 'completed', 'all']).optional().default('open'),
    },
    async ({ topic, status }) => {
      const kv = env?.EDGE_KV as any;
      if (!kv) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const all = await kvGetBounties(kv, topic);
        const filtered = status === 'all' ? all : all.filter(b => b.status === status);
        if (!filtered.length) {
          return { content: [{ type: 'text' as const, text: `No ${status === 'all' ? '' : status + ' '}bounties for topic "${topic}".` }] };
        }
        const lines = [
          `${filtered.length} ${status === 'all' ? '' : status + ' '}bounty/bounties for "${topic}":\n`,
          ...filtered.map(formatBounty),
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── research_bounty_claim ──────────────────────────────────────────────────

  server.tool(
    'research_bounty_claim',
    `Claim a research bounty by submitting a qualifying published finding.
The finding must have been published with research_publish and its txHash recorded.

Verification checks:
  1. Finding's topics include the bounty topic
  2. If bounty specifies directionCategory — finding's directionCategory must match
  3. If bounty specifies minMetricDelta — finding's metricDelta must be ≤ threshold

If the bounty has an associated ERC-8183 escrow job (jobId set), this also calls
job_submit on-chain — the bounty poster can then call job_complete to release funds.
Requires EDGE_KV. Escrow submission also requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      topic:         z.string().describe('Research topic slug'),
      bountyId:      z.string().describe('Bounty id (e.g. "b-1741123456")'),
      findingTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).describe('txHash of the qualifying research_publish finding'),
      agentName:     z.string().optional().describe('Your agent tag (recorded as claimedBy)'),
    },
    async ({ topic, bountyId, findingTxHash, agentName }) => {
      const kv = env?.EDGE_KV as any;
      if (!kv) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const bounty = await kvGetBounty(kv, bountyId, topic);
        if (!bounty) return { content: [{ type: 'text' as const, text: `Bounty "${bountyId}" not found.` }] };
        if (bounty.status !== 'open') {
          return { content: [{ type: 'text' as const, text: `Bounty "${bountyId}" is already ${bounty.status}.` }] };
        }

        const summary = await kvGetInsightSummary(kv, findingTxHash);
        if (!summary) {
          return { content: [{ type: 'text' as const, text: `Finding ${findingTxHash} not found in KV — ensure it was published with research_publish and KV has been updated.` }] };
        }

        const disqualified = verifyBountyQualification(bounty, summary);
        if (disqualified) {
          return { content: [{ type: 'text' as const, text: `Claim rejected: ${disqualified}` }] };
        }

        // Mark claimed
        const updated: ResearchBounty = {
          ...bounty, status: 'claimed',
          claimedBy: agentName ?? summary.agentId,
          claimedTxHash: findingTxHash,
        };
        await kvUpdateBounty(kv, updated);

        const lines = [`Bounty claimed!`, `  bountyId: ${bountyId}`, `  finding:  ${findingTxHash}`];

        // Submit on-chain if escrow job exists
        if (bounty.jobId && env?.ACP_ADDRESS && env?.PRIVATE_KEY) {
          const { encodeSubmit } = await import('./acp.js');
          const submitCalldata = encodeSubmit(Number(bounty.jobId), findingTxHash);
          const submitTx = await acpWrite(env, submitCalldata);
          lines.push(`  jobSubmit: ${submitTx}`);
          lines.push(`\nEscrow job J-${bounty.jobId} submitted. The bounty poster must call job_complete to release funds.`);
        } else {
          lines.push(`\nAdvisory bounty — no escrow to release. Notify the bounty poster (${bounty.postedBy ?? 'unknown'}) directly.`);
        }

        // ERC-8004: drip reputation for the claiming agent (KV + optional on-chain)
        const claimingAgentId = summary.agentId.toLowerCase();
        if (env?.AGENT_IDENTITY_ADDRESS) {
          const rpcUrl  = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
          const tokenId = await identityGetTokenId(claimingAgentId, env.AGENT_IDENTITY_ADDRESS, rpcUrl).catch(() => 0);
          if (tokenId > 0) {
            // Update KV rep summary
            await kvUpdateAgentRep(kv, claimingAgentId, tokenId, { bountyDelta: 1, scoreDelta: 0.01 });
            lines.push(`  reputation: +0.01 dripped (ERC-8004 tokenId ${tokenId})`);
            // Fire-and-forget on-chain write if reputation contract available
            if (env.AGENT_REPUTATION_ADDRESS) {
              repSubmitFeedback(env, tokenId, 1n * BigInt(1e16), ['bounty-claim'], findingTxHash).catch(() => {});
            }
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ===========================================================================
  // ERC-8183 — Agentic Commerce Protocol (job_ tools)
  //
  // Dual-write architecture:
  //   HyberACP contract  — authoritative state, escrow, payment
  //   HyberDB            — rich metadata (title, labels, priority, comments)
  //   KV cache           — fast job listing (key: acp:{workspace}:{jobId})
  //
  // All write tools require ACP_ADDRESS + PRIVATE_KEY.
  // ===========================================================================

  function requireAcp(): string | null {
    if (!env?.ACP_ADDRESS)  return 'ACP_ADDRESS not configured — deploy HyberACP.sol first.';
    if (!env?.PRIVATE_KEY)  return 'PRIVATE_KEY not configured — ACP writes disabled.';
    return null;
  }

  async function jobMeta(workspace: string, jobId: string): Promise<ACPJobMeta | null> {
    if (!env?.HYBERDB_ADDRESS) return null;
    try {
      const val = await dbClient(rpcUrl, env).get(`${workspace}/jobs`, `J-${jobId}`);
      return val ? (val as unknown as ACPJobMeta) : null;
    } catch { return null; }
  }

  async function kvJobCacheSet(workspace: string, jobId: string, status: string, title: string): Promise<void> {
    const kv = env?.EDGE_KV as any;
    if (!kv) return;
    try {
      await kv.put(`acp:${workspace}:${jobId}`, JSON.stringify({ status, title, updatedAt: Math.floor(Date.now() / 1000) }));
    } catch { /* non-critical */ }
  }

  // ── job_create ─────────────────────────────────────────────────────────────

  server.tool(
    'job_create',
    `Create an ERC-8183 job on Berachain with optional ERC-20 escrow.
Stores rich metadata (title, labels, priority) in HyberDB alongside the on-chain record.
evaluator defaults to the gateway wallet if not specified.
token + budget are required for paid jobs; omit (or set to zero/empty) for unpaid coordination jobs.
Requires ACP_ADDRESS + PRIVATE_KEY + HYBERDB_ADDRESS.`,
    {
      workspace:   z.string().describe('Workspace slug, e.g. "my-team"'),
      project:     z.string().describe('Project id slug'),
      title:       z.string().describe('Human-readable job title (stored in HyberDB)'),
      description: z.string().optional().default('').describe('Job spec — stored on-chain (inline or hyte:0x{txhash} ref)'),
      provider:    z.string().optional().describe('Provider wallet address; omit = open (any provider may claim)'),
      evaluator:   z.string().optional().describe('Evaluator address; defaults to gateway wallet'),
      token:       z.string().optional().describe('ERC-20 token address for payment; omit = unpaid'),
      budget:      z.string().optional().default('0').describe('Token amount in base units (decimal string)'),
      expiredAt:   z.number().int().optional().default(0).describe('Unix timestamp deadline; 0 = no expiry'),
      hook:        z.string().optional().describe('IACPHook contract address; omit = no hooks'),
      priority:    z.enum(['urgent', 'high', 'medium', 'low']).optional().default('medium'),
      labels:      z.array(z.string()).optional().default([]),
    },
    async ({ workspace, project, title, description, provider, evaluator, token, budget, expiredAt, hook, priority, labels }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const { privateKeyToAccount } = await import('viem/accounts');
        const gwAddr = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();

        const calldata = encodeCreateJob(
          provider  ?? ZERO_ADDRESS,
          evaluator ?? ZERO_ADDRESS,     // contract defaults to msg.sender
          token     ?? ZERO_ADDRESS,
          BigInt(budget ?? '0'),
          expiredAt ?? 0,
          description || title,
          hook ?? ZERO_ADDRESS,
        );

        const txHash = await acpWrite(env!, calldata);

        // Extract jobId from JobCreated event
        const jobId = await getJobIdFromReceipt(
          env!.BERACHAIN_RPC ?? 'https://rpc.berachain.com',
          txHash,
          env!.ACP_ADDRESS!,
        ) ?? '?';

        const now = Math.floor(Date.now() / 1000);
        const meta: ACPJobMeta = {
          jobId, title, workspace, project,
          priority: priority ?? 'medium',
          labels:   labels   ?? [],
          deliverable: null,
          createdAt: now,
          updatedAt: now,
        };

        if (env?.HYBERDB_ADDRESS) {
          await dbClient(rpcUrl, env, true).set(`${workspace}/jobs`, `J-${jobId}`, meta as any);
        }

        await kvJobCacheSet(workspace, jobId, 'open', title);

        return { content: [{ type: 'text' as const, text: `Job created!\n  jobId:  J-${jobId}\n  status: OPEN\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_get ────────────────────────────────────────────────────────────────

  server.tool(
    'job_get',
    `Get an ERC-8183 job by ID. Merges on-chain state with HyberDB metadata and comments.
jobId is the numeric job ID returned by job_create (e.g. "1", "42").`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric, e.g. "1")'),
    },
    async ({ workspace, jobId }) => {
      if (!env?.ACP_ADDRESS) return { content: [{ type: 'text' as const, text: 'ACP_ADDRESS not configured.' }] };
      try {
        const [job, meta] = await Promise.all([
          acpReadJob(Number(jobId), rpcUrl, env.ACP_ADDRESS),
          jobMeta(workspace, jobId),
        ]);
        if (!job) return { content: [{ type: 'text' as const, text: `Job J-${jobId} not found.` }] };

        const lines = [formatJob(job, meta ?? undefined)];

        if (env?.HYBERDB_ADDRESS) {
          const comments = await dbClient(rpcUrl, env).getAll(`${workspace}/comments`, {
            where: { taskId: `J-${jobId}` } as any, orderBy: 'createdAt', orderDir: 'asc',
          });
          if (comments.records.length) {
            lines.push('\nComments:');
            for (const { val: v } of comments.records) {
              const c = v as any;
              lines.push(`  [${c.id}] ${c.author ?? 'anon'} @ ${new Date(c.createdAt * 1000).toISOString()}\n  ${c.body}`);
            }
          }
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_list ───────────────────────────────────────────────────────────────

  server.tool(
    'job_list',
    `List ERC-8183 jobs in a workspace. Reads from HyberDB metadata with optional filters.
On-chain status is authoritative — job_get returns live status; job_list uses cached metadata.`,
    {
      workspace: z.string().describe('Workspace slug'),
      project:   z.string().optional().describe('Filter by project id'),
      status:    z.enum(['open', 'funded', 'submitted', 'completed', 'rejected', 'expired']).optional(),
      limit:     z.number().int().positive().max(100).optional().default(25),
    },
    async ({ workspace, project, status, limit }) => {
      if (!env?.HYBERDB_ADDRESS) return { content: [{ type: 'text' as const, text: 'HyberDB not configured.' }] };
      if (!env?.ACP_ADDRESS)     return { content: [{ type: 'text' as const, text: 'ACP_ADDRESS not configured.' }] };
      try {
        const where: Record<string, unknown> = {};
        if (project) where.project = project;

        const result = await dbClient(rpcUrl, env).getAll(`${workspace}/jobs`, {
          where:    Object.keys(where).length ? where as any : undefined,
          orderBy:  'updatedAt',
          orderDir: 'desc',
          limit:    limit ?? 25,
        });

        if (!result.records.length) return { content: [{ type: 'text' as const, text: 'No jobs found.' }] };

        // Optionally fetch on-chain status for each job to filter by status
        let records = result.records;
        if (status) {
          const withStatus = await Promise.all(
            records.map(async ({ val }) => {
              const meta = val as unknown as ACPJobMeta;
              const job = await acpReadJob(Number(meta.jobId), rpcUrl, env!.ACP_ADDRESS!);
              return job?.status === status ? { val, job } : null;
            }),
          );
          const filtered = withStatus.filter(Boolean) as { val: any; job: any }[];
          const lines = filtered.map(({ val, job }) => formatJob(job, val as unknown as ACPJobMeta));
          return { content: [{ type: 'text' as const, text: `${filtered.length} job(s):\n\n${lines.join('\n\n')}` }] };
        }

        const lines = records.map(({ val }) => {
          const meta = val as unknown as ACPJobMeta;
          return `[J-${meta.jobId}] ${meta.title}  project: ${meta.project}  priority: ${meta.priority}`;
        });
        return { content: [{ type: 'text' as const, text: `${result.total} job(s):\n\n${lines.join('\n')}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_set_provider ───────────────────────────────────────────────────────

  server.tool(
    'job_set_provider',
    `Set the provider for an open job. Client-only. Job must be in Open status with no provider set.
Requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
      provider:  z.string().describe('Provider wallet address'),
    },
    async ({ workspace, jobId, provider }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const txHash = await acpWrite(env!, encodeSetProvider(BigInt(jobId), provider));
        if (env?.HYBERDB_ADDRESS) {
          await dbClient(rpcUrl, env, true).merge(`${workspace}/jobs`, `J-${jobId}`, { updatedAt: Math.floor(Date.now() / 1000) } as any);
        }
        return { content: [{ type: 'text' as const, text: `Provider set for J-${jobId}.\n  provider: ${provider}\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_fund ───────────────────────────────────────────────────────────────

  server.tool(
    'job_fund',
    `Fund an open job by locking the budget into escrow.
Sends two transactions: ERC-20 approve (if budget > 0), then fund().
Returns both txHashes — the fund tx confirms the escrow lock.
Requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
    },
    async ({ workspace, jobId }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const job = await acpReadJob(Number(jobId), rpcUrl, env!.ACP_ADDRESS!);
        if (!job) return { content: [{ type: 'text' as const, text: `Job J-${jobId} not found.` }] };
        if (job.status !== 'open') return { content: [{ type: 'text' as const, text: `Job J-${jobId} is ${job.status}, not open.` }] };

        const rpcUrl_ = env!.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
        let approveTxHash: string | null = null;

        if (BigInt(job.budget) > 0n && job.token !== ZERO_ADDRESS) {
          approveTxHash = await erc20Approve(env!, job.token, env!.ACP_ADDRESS!, BigInt(job.budget));
          await waitReceipt(rpcUrl_, approveTxHash);
        }

        const fundTxHash = await acpWrite(env!, encodeFund(BigInt(jobId)));

        await kvJobCacheSet(workspace, jobId, 'funded', '');

        const lines = [`J-${jobId} funded — escrow locked.`, `  fundTxHash: ${fundTxHash}`];
        if (approveTxHash) lines.push(`  approveTxHash: ${approveTxHash}`);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_submit ─────────────────────────────────────────────────────────────

  server.tool(
    'job_submit',
    `Provider submits a deliverable for a funded job. Transitions status to Submitted.
result can be a URL, a HyberText txHash, IPFS CID, or any string — encoded as UTF-8 bytes on-chain.
Requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
      result:    z.string().describe('Deliverable reference — URL, txHash, CID, or description'),
    },
    async ({ workspace, jobId, result }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        // Encode result string as hex bytes
        const resultHex = ('0x' + Buffer.from(result, 'utf8').toString('hex')) as `0x${string}`;
        const txHash = await acpWrite(env!, encodeSubmit(BigInt(jobId), resultHex));

        if (env?.HYBERDB_ADDRESS) {
          const deliverable = /^0x[a-fA-F0-9]{64}$/.test(result) ? result : null;
          await dbClient(rpcUrl, env, true).merge(`${workspace}/jobs`, `J-${jobId}`, {
            deliverable, updatedAt: Math.floor(Date.now() / 1000),
          } as any);
        }
        await kvJobCacheSet(workspace, jobId, 'submitted', '');

        return { content: [{ type: 'text' as const, text: `J-${jobId} submitted → SUBMITTED.\n  result: ${result}\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_complete ───────────────────────────────────────────────────────────

  server.tool(
    'job_complete',
    `Evaluator marks a submitted job as completed and releases escrowed funds to the provider.
Only the evaluator address can call this. Gateway wallet must be the evaluator (or have been set as evaluator at job_create).
reason is an optional bytes32 attestation (e.g. 0x prefixed hash).
Requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
      reason:    z.string().optional().default('0x').describe('Optional bytes32 attestation hash (0x-prefixed hex)'),
      comment:   z.string().optional().describe('Optional closing comment stored in HyberDB'),
    },
    async ({ workspace, jobId, reason, comment }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const r = reason && reason !== '0x' ? reason : '0x' + '00'.repeat(32);
        const txHash = await acpWrite(env!, encodeComplete(BigInt(jobId), r));

        if (env?.HYBERDB_ADDRESS) {
          await dbClient(rpcUrl, env, true).merge(`${workspace}/jobs`, `J-${jobId}`, { updatedAt: Math.floor(Date.now() / 1000) } as any);
          if (comment && env?.EDGE_KV) {
            const kv = env.EDGE_KV as any;
            const n  = await nextSeq(kv, workspace, 'comment');
            const { privateKeyToAccount } = await import('viem/accounts');
            const author = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
            await dbClient(rpcUrl, env, true).set(`${workspace}/comments`, `J-${jobId}:C-${n}`, {
              id: `C-${n}`, taskId: `J-${jobId}`, author, body: comment, createdAt: Math.floor(Date.now() / 1000),
            } as any);
          }
        }
        await kvJobCacheSet(workspace, jobId, 'completed', '');

        return { content: [{ type: 'text' as const, text: `J-${jobId} completed → COMPLETED. Funds released.\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_reject ─────────────────────────────────────────────────────────────

  server.tool(
    'job_reject',
    `Evaluator rejects a funded/submitted job and refunds the escrowed budget to the client.
Client may also reject an open (unfunded) job.
Requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
      reason:    z.string().optional().default('0x').describe('Optional bytes32 reason code (0x-prefixed hex)'),
      comment:   z.string().optional().describe('Optional reason stored as a comment in HyberDB'),
    },
    async ({ workspace, jobId, reason, comment }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const r = reason && reason !== '0x' ? reason : '0x' + '00'.repeat(32);
        const txHash = await acpWrite(env!, encodeReject(BigInt(jobId), r));

        if (env?.HYBERDB_ADDRESS && comment && env?.EDGE_KV) {
          const kv = env.EDGE_KV as any;
          const n  = await nextSeq(kv, workspace, 'comment');
          const { privateKeyToAccount } = await import('viem/accounts');
          const author = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
          await dbClient(rpcUrl, env, true).set(`${workspace}/comments`, `J-${jobId}:C-${n}`, {
            id: `C-${n}`, taskId: `J-${jobId}`, author, body: comment, createdAt: Math.floor(Date.now() / 1000),
          } as any);
        }
        await kvJobCacheSet(workspace, jobId, 'rejected', '');

        return { content: [{ type: 'text' as const, text: `J-${jobId} rejected → REJECTED. Budget refunded.\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_claim_refund ───────────────────────────────────────────────────────

  server.tool(
    'job_claim_refund',
    `Permissionless refund for an expired job. Works when the job deadline has passed and status is Funded or Submitted.
Returns the escrowed budget to the client.
Requires ACP_ADDRESS + PRIVATE_KEY.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
    },
    async ({ workspace, jobId }) => {
      const err = requireAcp();
      if (err) return { content: [{ type: 'text' as const, text: err }] };
      try {
        const txHash = await acpWrite(env!, encodeClaimRefund(BigInt(jobId)));
        await kvJobCacheSet(workspace, jobId, 'expired', '');
        return { content: [{ type: 'text' as const, text: `J-${jobId} → EXPIRED. Budget refunded.\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── job_comment ────────────────────────────────────────────────────────────

  server.tool(
    'job_comment',
    `Add a comment to a job. Stored in HyberDB only — no on-chain transaction.
Use for progress updates, questions, and coordination.
Requires PRIVATE_KEY + HYBERDB_ADDRESS + EDGE_KV.`,
    {
      workspace: z.string().describe('Workspace slug'),
      jobId:     z.string().describe('Job ID (numeric)'),
      body:      z.string().describe('Comment text'),
      author:    z.string().optional().describe('Author address (defaults to gateway wallet)'),
    },
    async ({ workspace, jobId, body, author }) => {
      const tbErr = requireTaskboard();
      if (tbErr) return { content: [{ type: 'text' as const, text: tbErr }] };
      try {
        const kv  = env!.EDGE_KV as any;
        const n   = await nextSeq(kv, workspace, 'comment');
        const id  = `C-${n}`;
        const now = Math.floor(Date.now() / 1000);
        let resolvedAuthor = author ?? null;
        if (!resolvedAuthor) {
          try {
            const { privateKeyToAccount } = await import('viem/accounts');
            resolvedAuthor = privateKeyToAccount(env!.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
          } catch { /* optional */ }
        }
        const txHash = await dbClient(rpcUrl, env!, true).set(
          `${workspace}/comments`, `J-${jobId}:${id}`, { id, taskId: `J-${jobId}`, author: resolvedAuthor, body, createdAt: now } as any,
        );
        return { content: [{ type: 'text' as const, text: `Comment [${id}] added to J-${jobId}.\n  txHash: ${txHash}` }] };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ===========================================================================
  // Message board — threaded async communication between agents
  //
  // Analogous to AgentHub's message board: named channels, posts with optional
  // parentId for threading, optional links to git commits and research insights.
  //
  // KV layout:
  //   board:channel:{name}     — BoardPost[] newest-first, max 200
  //   board:channels:index     — {name,postCount,lastActivity}[] newest-first
  // ===========================================================================

  // ── board_post ─────────────────────────────────────────────────────────────

  server.tool(
    'board_post',
    `Post a message to a named agent message board channel.
Use this to discuss findings with parallel agents, flag contradictions, ask for
context on a prior result, or share mid-session observations that aren't yet worth
a full research_publish.

Each research topic has a matching channel (e.g. topic "gpt-training" → channel "gpt-training").
Other agents will see your post when they call board_read or research_join.

Include commitHash to let others fetch and build on your exact code.
Include insightTxHash to link the discussion to a published finding.
Use parentId to reply to an existing post.
Requires EDGE_KV.`,
    {
      channel:        z.string().describe('Channel name — use the topic slug (e.g. "gpt-training") or a general name like "general"'),
      content:        z.string().max(4096).describe('Message body'),
      agentName:      z.string().optional().describe('Your agent tag (e.g. "mar9-t") — shown instead of address'),
      parentId:       z.string().optional().describe('Post id to reply to (for threaded discussion)'),
      topic:          z.string().optional().describe('Research topic this post relates to'),
      commitHash:     z.string().optional().describe('Git commit hash your post references (lets others fetch your code)'),
      insightTxHash:  z.string().optional().describe('txHash of a published insight this post discusses'),
    },
    async ({ channel, content, agentName, parentId, topic, commitHash, insightTxHash }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv  = env.EDGE_KV as any;
        const now = Math.floor(Date.now() / 1000);
        let agentId: string | undefined;
        if (env.PRIVATE_KEY) {
          try {
            const { privateKeyToAccount } = await import('viem/accounts');
            agentId = privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase();
          } catch { /* optional */ }
        }
        const post: Omit<BoardPost, 'id'> = {
          channel: channel.toLowerCase(),
          content: content.slice(0, 4096),
          timestamp: now,
          ...(agentName      ? { agentName }      : {}),
          ...(agentId        ? { agentId }        : {}),
          ...(parentId       ? { parentId }       : {}),
          ...(topic          ? { topic }          : {}),
          ...(commitHash     ? { commitHash }     : {}),
          ...(insightTxHash  ? { insightTxHash }  : {}),
        };
        const id = await kvAddPost(kv, post);
        return {
          content: [{
            type: 'text' as const,
            text: [
              `Posted to #${channel} — id: ${id}`,
              parentId ? `  reply to: ${parentId}` : '',
              `  board_read({ channel: "${channel}" }) to see the thread.`,
            ].filter(Boolean).join('\n'),
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── board_read ─────────────────────────────────────────────────────────────

  server.tool(
    'board_read',
    `Read messages from a board channel, displayed as threaded conversations.
Call this to see what other agents are discussing about a topic — hypotheses,
contradictions, failures, and mid-session observations that aren't in research_publish.
Requires EDGE_KV.`,
    {
      channel:  z.string().describe('Channel name (e.g. "gpt-training")'),
      limit:    z.number().int().min(1).max(100).optional().default(40).describe('Max posts to fetch (includes replies)'),
    },
    async ({ channel, limit }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv    = env.EDGE_KV as any;
        const posts = await kvGetChannel(kv, channel, limit ?? 40);
        if (!posts.length) {
          return { content: [{ type: 'text' as const, text: `#${channel} is empty.\nPost with: board_post({ channel: "${channel}", content: "..." })` }] };
        }
        const text = formatBoardThread(posts);
        return {
          content: [{
            type: 'text' as const,
            text: `#${channel}  (${posts.length} posts)\n\n${text}`,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  // ── board_channels ─────────────────────────────────────────────────────────

  server.tool(
    'board_channels',
    `List all active message board channels, sorted by most recent activity.
Use topic to filter to channels relevant to a research topic.
Requires EDGE_KV.`,
    {
      topic: z.string().optional().describe('Filter channels by topic name (partial match)'),
    },
    async ({ topic }) => {
      if (!env?.EDGE_KV) return { content: [{ type: 'text' as const, text: 'EDGE_KV not configured.' }] };
      try {
        const kv       = env.EDGE_KV as any;
        const channels = await kvGetBoardChannels(kv, topic);
        if (!channels.length) {
          return { content: [{ type: 'text' as const, text: 'No board channels yet. Start one with board_post.' }] };
        }
        const lines = channels.map(c => {
          const ago = Math.floor((Date.now() / 1000 - c.lastActivity) / 60);
          return `  #${c.name.padEnd(24)} ${c.postCount} posts  last: ${ago < 60 ? `${ago}m ago` : `${Math.floor(ago / 60)}h ago`}`;
        });
        return {
          content: [{
            type: 'text' as const,
            text: `Active channels:\n${lines.join('\n')}\n\nRead: board_read({ channel: "<name>" })`,
          }],
        };
      } catch (e: unknown) {
        return { content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : e}` }] };
      }
    }
  );

  return server;
}
