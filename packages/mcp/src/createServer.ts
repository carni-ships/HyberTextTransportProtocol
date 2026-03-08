import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { resolveSite, extractTar, ContentType } from './resolver.js';
import { queryIndex } from './index-query.js';
import { publishHtml, type Env } from './upload.js';
import { HyberDBClient } from '@hybertext/db';

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

      const lines = cards.map(c =>
        `${c.address}  ${c.name}\n  ${c.description}\n  capabilities: ${c.capabilities.join(', ')}${c.endpoint ? `\n  endpoint: ${c.endpoint}` : ''}`
      );
      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
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

  return server;
}
