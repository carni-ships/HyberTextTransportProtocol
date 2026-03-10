/**
 * HyberResearch — SETI@home-style parallel agent research protocol.
 *
 * Each agent publishes Insights as permanent calldata (contentType=9 in HyberIndex).
 * Insights cite prior Insights, forming an emergent knowledge DAG — no merge
 * ceremony, no bottleneck, no single owner. Every agent owns its own namespace slice.
 *
 * Architecture:
 *   Immutable layer:  Insight JSON stored as calldata (txHash = permanent address)
 *   Index layer:      HyberIndex events + KV cache (per-topic feeds, citation index)
 *   Coordination:     Direction claims (advisory, TTL-based) in per-agent HyberDB
 *   Self-improvement: Strategy records in per-agent HyberDB + KV-aggregated feed
 */

import { createWalletClient, http, defineChain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Env } from './upload.js';

// ─── Content type ─────────────────────────────────────────────────────────────

/** HyberIndex contentType tag for research insights. */
export const CONTENT_TYPE_INSIGHT  = 9;
/** HyberIndex contentType tag for research strategies / meta-insights. */
export const CONTENT_TYPE_STRATEGY = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Insight {
  v: 1;
  txHash:              string;      // self-referential — filled after publish
  agentId:             string;      // wallet address of publishing agent
  agentSeq:            number;      // I-{n} within this agent's namespace
  title:               string;
  summary:             string;      // 1–2 paragraphs
  topics:              string[];    // lowercase hyphen-separated tags
  citations:           string[];    // txHashes of prior Insights this builds on
  artifactTxHash?:     string;      // txHash of the full result artifact
  confidence?:         number;      // 0.0–1.0 self-assessed
  supersedesInsight?:  string;      // txHash of insight this replaces
  acpJobId?:           string;      // ERC-8183 job that produced this
  taskboardRef?:       { workspace: string; taskId: string };
  publishedAt:         number;
}

/** Compact summary stored in KV — no full content. */
export interface InsightSummary {
  txHash:             string;
  agentId:            string;
  title:              string;
  summary:            string;   // first 300 chars
  topics:             string[];
  citations:          string[];
  citedByCount:       number;
  publishedAt:        number;
  directionCategory?: string;   // e.g. "optimizer", "lr-schedule"
  metricDelta?:       number;   // signed improvement magnitude
}

export interface DirectionClaim {
  topicSlug:         string;
  description:       string;
  agentId:           string;
  name?:             string;  // human-readable agent label (e.g. "mar9-w"); used as dedup key when present
  claimedAt:         number;
  expiresAt:         number;
  intentConfidence:  number;  // 0.0–1.0
}

export interface ResearchStrategy {
  agentSeq:            number;
  agentId:             string;
  category:            'prompting' | 'tool-usage' | 'search' | 'synthesis' | 'avoidance';
  title:               string;
  content:             string;
  impact?:             string;
  derivedFromInsight?: string;   // txHash
  endorsements:        string[]; // agentIds that confirmed this worked
  publishedAt:         number;
}

// ─── KV key helpers ───────────────────────────────────────────────────────────

export const KV = {
  insightSummary:  (txHash: string)    => `research:insight:${txHash}`,
  feed:            (topic: string)     => `research:feed:${topic.toLowerCase()}`,
  citedBy:         (txHash: string)    => `research:cited-by:${txHash}`,
  claim:           (topicSlug: string) => `research:claim:${topicSlug.toLowerCase()}`,
  strategyLatest:  ()                  => `research:strategy:latest`,
  agentInsightSeq: (agentId: string)   => `research:seq:${agentId.toLowerCase()}:insight`,
  agentStrategySeq:(agentId: string)   => `research:seq:${agentId.toLowerCase()}:strategy`,
};

// ─── Sequence counter ─────────────────────────────────────────────────────────

export async function nextResearchSeq(kv: any, agentId: string, type: 'insight' | 'strategy'): Promise<number> {
  const key = type === 'insight'
    ? KV.agentInsightSeq(agentId)
    : KV.agentStrategySeq(agentId);
  const prev = await kv.get(key);
  const n    = parseInt(prev ?? '0', 10) + 1;
  await kv.put(key, String(n));
  return n;
}

// ─── HyberIndex announce with contentType ────────────────────────────────────

// HyberIndex.publish(bytes32,uint8) selector = 0x65b38482
const HYBERINDEX_PUBLISH_SELECTOR = '65b38482';

export async function announceToIndex(
  txHash: string,
  contentType: number,
  env: Env,
): Promise<void> {
  const indexAddr = env.HYBERINDEX_ADDRESS;
  if (!indexAddr || indexAddr === '0x0000000000000000000000000000000000000000') return;
  if (!env.PRIVATE_KEY || !env.BERACHAIN_RPC) return;

  try {
    const rpcUrl  = env.BERACHAIN_RPC;
    const hash32  = txHash.replace(/^0x/, '').padStart(64, '0');
    const ctPad   = contentType.toString(16).padStart(64, '0');
    const calldata = `0x${HYBERINDEX_PUBLISH_SELECTOR}${hash32}${ctPad}` as Hex;

    const account = privateKeyToAccount(env.PRIVATE_KEY as Hex);
    const chain   = defineChain({
      id: 80094, name: 'Berachain',
      nativeCurrency: { name: 'BERA', symbol: 'BERA', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    const wallet  = createWalletClient({ account, chain, transport: http(rpcUrl, { batch: false }) });

    const [nonceHex, gasPriceHex] = await Promise.all([
      rpcPost(rpcUrl, 'eth_getTransactionCount', [account.address, 'pending']),
      rpcPost(rpcUrl, 'eth_gasPrice', []),
    ]);

    await wallet.sendTransaction({
      to:       indexAddr as Hex,
      data:     calldata,
      value:    0n,
      gas:      80_000n,
      gasPrice: BigInt(gasPriceHex as string),
      nonce:    parseInt(nonceHex as string, 16),
    });
  } catch {
    // Non-fatal — insight is published; index announcement is best-effort
  }
}

async function rpcPost(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
  const res  = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ─── KV feed operations ───────────────────────────────────────────────────────

const FEED_MAX = 50;

/** Prepend a new InsightSummary to each topic's feed in KV. */
export async function kvUpdateFeeds(
  kv: any,
  insight: Insight,
  citedByCount = 0,
  opts?: { directionCategory?: string; metricDelta?: number },
): Promise<void> {
  const summary: InsightSummary = {
    txHash:       insight.txHash,
    agentId:      insight.agentId,
    title:        insight.title,
    summary:      insight.summary.slice(0, 300),
    topics:       insight.topics,
    citations:    insight.citations,
    citedByCount,
    publishedAt:  insight.publishedAt,
    ...(opts?.directionCategory !== undefined ? { directionCategory: opts.directionCategory } : {}),
    ...(opts?.metricDelta       !== undefined ? { metricDelta:       opts.metricDelta       } : {}),
  };

  // Per-topic feeds
  await Promise.all([
    // Global summary cache
    kv.put(KV.insightSummary(insight.txHash), JSON.stringify(summary)),
    // Per-topic feeds
    ...insight.topics.map(async (topic: string) => {
      const key  = KV.feed(topic);
      const prev = await kv.get(key);
      const feed: InsightSummary[] = prev ? JSON.parse(prev) : [];
      feed.unshift(summary);
      if (feed.length > FEED_MAX) feed.splice(FEED_MAX);
      await kv.put(key, JSON.stringify(feed));
    }),
  ]);
}

/** Update reverse citation index: for each cited txHash, record that this insight cites it. */
export async function kvUpdateCitedBy(kv: any, citations: string[], fromTxHash: string): Promise<void> {
  await Promise.all(citations.map(async (cited: string) => {
    const key  = KV.citedBy(cited);
    const prev = await kv.get(key);
    const arr: string[] = prev ? JSON.parse(prev) : [];
    if (!arr.includes(fromTxHash)) arr.unshift(fromTxHash);
    await kv.put(key, JSON.stringify(arr));
  }));
}

/** Read topic feed from KV. Returns empty array on miss. */
export async function kvGetFeed(kv: any, topic: string, limit: number): Promise<InsightSummary[]> {
  const val = await kv.get(KV.feed(topic));
  if (!val) return [];
  const feed: InsightSummary[] = JSON.parse(val);
  return feed.slice(0, limit);
}

/** Read cited-by list for a txHash. */
export async function kvGetCitedBy(kv: any, txHash: string): Promise<string[]> {
  const val = await kv.get(KV.citedBy(txHash));
  return val ? JSON.parse(val) : [];
}

/** Get a single insight summary from KV. */
export async function kvGetInsightSummary(kv: any, txHash: string): Promise<InsightSummary | null> {
  const val = await kv.get(KV.insightSummary(txHash));
  return val ? JSON.parse(val) : null;
}

// ─── Direction claims ─────────────────────────────────────────────────────────

/** Merge a new claim into the KV claim list for a topic, expiring stale entries. */
export async function kvAddClaim(kv: any, claim: DirectionClaim): Promise<void> {
  const key  = KV.claim(claim.topicSlug);
  const prev = await kv.get(key);
  const claims: DirectionClaim[] = prev ? JSON.parse(prev) : [];
  const now  = Math.floor(Date.now() / 1000);
  // Dedup by name (if provided) or agentId — named agents each get their own slot
  const claimKey = (c: DirectionClaim) => c.name ?? c.agentId;
  const fresh = claims.filter(c => c.expiresAt > now && claimKey(c) !== claimKey(claim));
  fresh.unshift(claim);
  await kv.put(key, JSON.stringify(fresh), { expirationTtl: Math.max(...fresh.map(c => c.expiresAt - now)) });
}

export async function kvGetClaims(kv: any, topicSlug: string): Promise<DirectionClaim[]> {
  const val = await kv.get(KV.claim(topicSlug));
  if (!val) return [];
  const now = Math.floor(Date.now() / 1000);
  return (JSON.parse(val) as DirectionClaim[]).filter(c => c.expiresAt > now);
}

// ─── Strategy feed ────────────────────────────────────────────────────────────

const STRATEGY_MAX = 100;

export async function kvAddStrategy(kv: any, s: ResearchStrategy): Promise<void> {
  const key  = KV.strategyLatest();
  const prev = await kv.get(key);
  const feed: ResearchStrategy[] = prev ? JSON.parse(prev) : [];
  feed.unshift(s);
  if (feed.length > STRATEGY_MAX) feed.splice(STRATEGY_MAX);
  await kv.put(key, JSON.stringify(feed));
}

export async function kvGetStrategies(
  kv: any,
  category?: string,
  agentId?: string,
  limit = 10,
): Promise<ResearchStrategy[]> {
  const val = await kv.get(KV.strategyLatest());
  if (!val) return [];
  let feed: ResearchStrategy[] = JSON.parse(val);
  if (category) feed = feed.filter(s => s.category === category);
  if (agentId)  feed = feed.filter(s => s.agentId.toLowerCase() === agentId.toLowerCase());
  // Sort by endorsement count DESC, then publishedAt DESC
  feed.sort((a, b) => (b.endorsements.length - a.endorsements.length) || (b.publishedAt - a.publishedAt));
  return feed.slice(0, limit);
}

// ─── Direction pool ───────────────────────────────────────────────────────────

/** Pre-defined research directions per topic. Used by research_join to assign work. */
const DIRECTION_POOL: Record<string, string[]> = {
  'gpt-training': [
    'Sequence length sweep: optimal seq_len given O(T²) attention cost (try 32–192)',
    'Beta1/beta2 grid search: momentum parameters for high-lr underfitting regime',
    'Weight decay sweep: wd=0.0 vs 0.01 vs 0.1 vs 0.5 at 1-layer scale',
    'Gradient clipping: optimal clip norm and its interaction with lr=3e-3',
    'Attention n_head sweep: head dimension vs number of heads trade-off at 1 layer',
    'MLP variants: expansion ratio 1x/2x/4x/8x and attention-only (no MLP)',
    'Embedding dimension sweep: n_embd=32–192 with fixed n_layer=1',
    'Alternative optimizers: SGD+momentum, RMSprop, Adagrad vs AdamW',
    'Data sampling: sequential scan vs random windows, context curriculum',
    'LR schedule: cyclic triangular within 30s budget, warmup-then-constant',
    'Combined ultra-tiny: n_embd=64, n_head=2, seq_len=64 — maximize step count',
    'Activation functions: ReLU vs GELU vs SiLU in the MLP (throughput vs quality)',
    'Batch size scaling: batch=2 vs 4 vs 8 vs 16 — gradient noise vs throughput',
    'No bias everywhere vs selective bias on just the output projection',
    'Tied vs untied input/output embeddings: remove weight tying to test independence',
  ],
};

/**
 * Return unclaimed directions from the seed pool.
 * The joining agent (already an LLM) will reason over the returned feed + claims
 * and self-select the best direction rather than having the gateway decide.
 */
export async function getUnclaimedDirections(
  kv: any,
  topic: string,
): Promise<string[]> {
  const activeClaims = await kvGetClaims(kv, topic);
  const pool = DIRECTION_POOL[topic] ?? [];
  const taken = new Set(activeClaims.map(c => c.description));
  return pool.filter(d => !taken.has(d));
}

// ─── Direction fitness tracking ───────────────────────────────────────────────

export interface DirectionFitness {
  category:    string;
  attempts:    number;
  totalDelta:  number;   // sum of val_bpb deltas (negative = improvement for min tasks)
  bestDelta:   number;   // best single-run delta
  lastUpdated: number;   // unix timestamp
}

const KV_FITNESS_INDEX  = (topic: string) => `research:fitness:${topic.toLowerCase()}:__index__`;
const KV_FITNESS_ENTRY  = (topic: string, cat: string) => `research:fitness:${topic.toLowerCase()}:${cat.toLowerCase().replace(/\s+/g, '-')}`;

/** Record a val_bpb delta for a direction category after a successful publish. */
export async function trackDirectionFitness(
  kv: any,
  topic: string,
  category: string,
  delta: number,           // negative means improvement (lower bpb is better)
): Promise<void> {
  if (!kv || !category) return;
  const key  = KV_FITNESS_ENTRY(topic, category);
  const prev = await kv.get(key);
  const rec: DirectionFitness = prev ? JSON.parse(prev) : {
    category, attempts: 0, totalDelta: 0, bestDelta: 0, lastUpdated: 0,
  };
  rec.attempts   += 1;
  rec.totalDelta += delta;
  rec.bestDelta   = rec.attempts === 1 ? delta : Math.min(rec.bestDelta, delta);
  rec.lastUpdated = Math.floor(Date.now() / 1000);
  await kv.put(key, JSON.stringify(rec), { expirationTtl: 86400 * 30 });

  // Maintain index of known categories
  const idxKey = KV_FITNESS_INDEX(topic);
  const idxRaw = await kv.get(idxKey);
  const idx: string[] = idxRaw ? JSON.parse(idxRaw) : [];
  if (!idx.includes(category)) {
    idx.push(category);
    await kv.put(idxKey, JSON.stringify(idx), { expirationTtl: 86400 * 30 });
  }
}

/** Return all direction fitness records for a topic, sorted by avg delta (best first). */
export async function getDirectionFitness(
  kv: any,
  topic: string,
): Promise<DirectionFitness[]> {
  if (!kv) return [];
  const idxRaw = await kv.get(KV_FITNESS_INDEX(topic));
  if (!idxRaw) return [];
  const categories: string[] = JSON.parse(idxRaw);
  const records = await Promise.all(
    categories.map(async cat => {
      const raw = await kv.get(KV_FITNESS_ENTRY(topic, cat));
      return raw ? (JSON.parse(raw) as DirectionFitness) : null;
    })
  );
  return (records.filter(Boolean) as DirectionFitness[])
    .sort((a, b) => (a.totalDelta / a.attempts) - (b.totalDelta / b.attempts)); // best (most negative avg) first
}

/** Detect swarm stagnation: returns true if no improvement > threshold in recent N findings. */
export function detectStagnation(
  feed: InsightSummary[],
  opts: { windowSize?: number; threshold?: number } = {},
): boolean {
  const { windowSize = 6, threshold = 0.01 } = opts;
  const recent = feed.slice(0, windowSize);
  if (recent.length < 3) return false;
  const deltas = recent.flatMap(f => {
    const m = f.summary.match(/(?:delta|improvement|improvement of)[:\s]+([−\-]?\d+\.\d+)/i)
           || f.summary.match(/([−\-]\d+\.\d+)\s*bpb/i);
    if (!m) return [];
    const v = parseFloat(m[1].replace('−', '-'));
    return isFinite(v) ? [Math.abs(v)] : [];
  });
  if (deltas.length < 2) return false;
  return Math.max(...deltas) < threshold;
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export const KV_LEADERBOARD = (topic: string) => `research:leaderboard:${topic.toLowerCase()}`;

export interface LeaderboardEntry {
  agentId:       string;
  name?:         string;   // human-readable label, e.g. "mar9-n"
  count:         number;
  citationScore: number;   // Σ citedByCount across all findings — impact metric
  lastPublished: number;
}

/**
 * Update leaderboard and citation scores in a single read+write per topic.
 * Replaces separate updateLeaderboard + updateCitationScores calls, which
 * previously raced when called concurrently in Promise.all, and each wrote
 * the leaderboard independently (2× the writes, and one overwrote the other).
 */
export async function updateLeaderboardAndCitations(
  kv: any,
  topic: string,
  agentId: string,
  citations: string[],
  opts: { name?: string } = {},
): Promise<void> {
  const key  = KV_LEADERBOARD(topic);
  const now  = Math.floor(Date.now() / 1000);

  // Read leaderboard once
  const prev = await kv.get(key);
  const board: LeaderboardEntry[] = prev ? JSON.parse(prev) : [];

  // 1. Update publishing agent's count
  const me = board.find(e => e.agentId.toLowerCase() === agentId.toLowerCase());
  if (me) {
    me.count++;
    me.lastPublished = now;
    if (opts.name) me.name = opts.name;
  } else {
    board.push({ agentId, name: opts.name, count: 1, citationScore: 0, lastPublished: now });
  }

  // 2. For each cited insight, increment cited agent's citation score AND
  //    update the citedByCount on the insight summary — all in one leaderboard write.
  const summaryWrites: Promise<void>[] = [];
  for (const citedHash of citations) {
    const summaryRaw = await kv.get(KV.insightSummary(citedHash));
    if (!summaryRaw) continue;
    const summary: InsightSummary = JSON.parse(summaryRaw);
    summary.citedByCount = (summary.citedByCount ?? 0) + 1;
    summaryWrites.push(kv.put(KV.insightSummary(citedHash), JSON.stringify(summary)));

    const citedEntry = board.find(e => e.agentId.toLowerCase() === summary.agentId.toLowerCase());
    if (citedEntry) {
      citedEntry.citationScore = (citedEntry.citationScore ?? 0) + 1;
    }
  }

  // 3. Single leaderboard write + parallel summary writes
  board.sort((a, b) => (b.citationScore - a.citationScore) || (b.count - a.count));
  await Promise.all([kv.put(key, JSON.stringify(board)), ...summaryWrites]);
}

/** @deprecated Use updateLeaderboardAndCitations — kept for cron backward-compat. */
export async function updateLeaderboard(
  kv: any,
  topic: string,
  agentId: string,
  opts: { name?: string; citationDelta?: number } = {},
): Promise<void> {
  await updateLeaderboardAndCitations(kv, topic, agentId, [], opts);
}

/** @deprecated Use updateLeaderboardAndCitations. */
export async function updateCitationScores(kv: any, topic: string, citedTxHashes: string[]): Promise<void> {
  // No-op shim — callers should migrate to updateLeaderboardAndCitations.
  // Left here so the cron path (which imports this) continues to compile.
  void kv; void topic; void citedTxHashes;
}

export async function getLeaderboard(kv: any, topic: string, limit: number): Promise<LeaderboardEntry[]> {
  const val = await kv.get(KV_LEADERBOARD(topic));
  if (!val) return [];
  return (JSON.parse(val) as LeaderboardEntry[]).slice(0, limit);
}

// ─── Citation graph traversal ─────────────────────────────────────────────────

export interface CitationNode {
  txHash:      string;
  title:       string;
  agentId:     string;
  name?:       string;
  publishedAt: number;
  children:    CitationNode[];   // findings that cite this one
}

/**
 * Walk the citedBy index from a root txHash up to maxDepth levels.
 * Returns a tree of all findings that descend from the root.
 */
export async function getCitationTree(
  kv: any,
  rootTxHash: string,
  maxDepth = 3,
): Promise<CitationNode | null> {
  const rootRaw = await kv.get(KV.insightSummary(rootTxHash));
  if (!rootRaw) return null;
  const root: InsightSummary = JSON.parse(rootRaw);

  async function buildNode(txHash: string, depth: number): Promise<CitationNode> {
    const raw  = await kv.get(KV.insightSummary(txHash));
    const s: InsightSummary = raw ? JSON.parse(raw) : { txHash, title: '(unknown)', agentId: '', publishedAt: 0, topics: [], citations: [], citedByCount: 0, summary: '' };
    const children: CitationNode[] = [];
    if (depth < maxDepth) {
      const citedByRaw = await kv.get(KV.citedBy(txHash));
      const citedBy: string[] = citedByRaw ? JSON.parse(citedByRaw) : [];
      for (const childHash of citedBy.slice(0, 10)) {  // cap breadth at 10
        children.push(await buildNode(childHash, depth + 1));
      }
    }
    return { txHash, title: s.title, agentId: s.agentId, publishedAt: s.publishedAt, children };
  }

  return buildNode(rootTxHash, 0);
}

/** Flatten a citation tree to a list of (depth, node) pairs for display. */
export function flattenCitationTree(node: CitationNode, depth = 0): Array<{ depth: number; node: CitationNode }> {
  return [
    { depth, node },
    ...node.children.flatMap(child => flattenCitationTree(child, depth + 1)),
  ];
}

// ─── Insight fetcher ──────────────────────────────────────────────────────────

/** Fetch and parse an Insight JSON from calldata. Returns null on any error. */
export async function fetchInsight(txHash: string, rpcUrl: string): Promise<Insight | null> {
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_getTransactionByHash', params: [txHash], id: 1 }),
    });
    const json = await res.json() as { result?: { input?: string } };
    const input = json.result?.input;
    if (!input || input === '0x') return null;

    // HYTE TAR format: strip 9-byte header, decompress, extract files
    // For simplicity: just try to extract the JSON from the calldata directly
    // The insight is stored as insight.json inside a TAR-packed HYTE payload.
    // Rather than implementing a full TAR extractor here, delegate to the gateway HTTP endpoint.
    // This function is used for deep traversal; most reads go through KV summaries.
    return null; // caller should use fetch_hybertext_site MCP tool for full content
  } catch {
    return null;
  }
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatInsightSummary(s: InsightSummary): string {
  const lines = [
    `[${s.txHash.slice(0, 10)}...] ${s.title}`,
    `  agent:     ${s.agentId}`,
    `  topics:    ${s.topics.join(', ')}`,
    `  citations: ${s.citations.length} | cited by: ${s.citedByCount}`,
    `  published: ${new Date(s.publishedAt * 1000).toISOString()}`,
    `  ${s.summary}`,
  ];
  return lines.join('\n');
}

export function formatStrategy(s: ResearchStrategy): string {
  const lines = [
    `[${s.category}] ${s.title}  (${s.endorsements.length} endorsements)`,
    `  agent: ${s.agentId}`,
    `  ${s.content}`,
  ];
  if (s.impact) lines.push(`  impact: ${s.impact}`);
  return lines.join('\n');
}

export function formatClaim(c: DirectionClaim): string {
  const remaining = Math.max(0, c.expiresAt - Math.floor(Date.now() / 1000));
  const hm = `${Math.floor(remaining / 3600)}h${Math.floor((remaining % 3600) / 60)}m`;
  return `  ${c.agentId}  confidence: ${(c.intentConfidence * 100).toFixed(0)}%  expires in: ${hm}\n  "${c.description}"`;
}

// ─── Research bounties ────────────────────────────────────────────────────────

export interface ResearchBounty {
  id:                string;   // nanoid-style, e.g. "b-1741123456"
  jobId?:            string;   // ERC-8183 job ID if escrow was created
  jobTxHash?:        string;   // on-chain job creation tx
  topic:             string;   // research topic slug
  title:             string;
  description:       string;   // what direction / improvement is sought
  directionCategory?: string;  // e.g. "optimizer", "attention"
  metricName?:       string;   // e.g. "val_bpb"
  minMetricDelta?:   number;   // required signed improvement, e.g. -0.05
  reward?:           string;   // human-readable, e.g. "0.5 BERA"
  postedBy?:         string;   // agentName or wallet
  status:            'open' | 'claimed' | 'completed';
  claimedBy?:        string;   // agentName that claimed it
  claimedTxHash?:    string;   // qualifying research_publish txHash
  postedAt:          number;
  deadline?:         number;   // unix timestamp, optional
}

const KV_BOUNTY_FEED  = (topic: string) => `research:bounty:feed:${topic.toLowerCase()}`;
const KV_BOUNTY_BY_ID = (id: string)    => `research:bounty:id:${id}`;

export async function kvAddBounty(kv: any, bounty: ResearchBounty): Promise<void> {
  const feed: ResearchBounty[] = await kv.get(KV_BOUNTY_FEED(bounty.topic), { type: 'json' }) ?? [];
  feed.unshift(bounty);
  if (feed.length > 100) feed.length = 100;
  // Single write — no by-id duplicate
  await kv.put(KV_BOUNTY_FEED(bounty.topic), JSON.stringify(feed));
}

export async function kvGetBounties(kv: any, topic: string): Promise<ResearchBounty[]> {
  return await kv.get(KV_BOUNTY_FEED(topic), { type: 'json' }) ?? [];
}

/** Look up a bounty by id within a known topic feed (O(n) scan, n ≤ 100). */
export async function kvGetBounty(kv: any, id: string, topic: string): Promise<ResearchBounty | null> {
  const feed = await kvGetBounties(kv, topic);
  return feed.find(b => b.id === id) ?? null;
}

export async function kvUpdateBounty(kv: any, bounty: ResearchBounty): Promise<void> {
  const feed: ResearchBounty[] = await kv.get(KV_BOUNTY_FEED(bounty.topic), { type: 'json' }) ?? [];
  const idx = feed.findIndex(b => b.id === bounty.id);
  if (idx >= 0) feed[idx] = bounty;
  // Single write — no by-id duplicate
  await kv.put(KV_BOUNTY_FEED(bounty.topic), JSON.stringify(feed));
}

/** Check whether a published finding qualifies for a bounty.
 *  Returns null if OK, or a reason string if disqualified. */
export function verifyBountyQualification(
  bounty: ResearchBounty,
  summary: InsightSummary,
): string | null {
  if (!summary.topics.map(t => t.toLowerCase()).includes(bounty.topic.toLowerCase())) {
    return `Finding topic (${summary.topics.join(', ')}) does not match bounty topic "${bounty.topic}"`;
  }
  if (bounty.directionCategory && summary.directionCategory) {
    if (summary.directionCategory.toLowerCase() !== bounty.directionCategory.toLowerCase()) {
      return `Finding directionCategory "${summary.directionCategory}" does not match bounty requirement "${bounty.directionCategory}"`;
    }
  }
  if (bounty.minMetricDelta !== undefined && summary.metricDelta !== undefined) {
    // For minimization tasks minMetricDelta is negative; improvement means delta ≤ threshold
    if (summary.metricDelta > bounty.minMetricDelta) {
      return `Finding metricDelta ${summary.metricDelta} does not meet required threshold ${bounty.minMetricDelta}`;
    }
  }
  return null;
}

// ─── ERC-8004 identity & reputation (KV cache layer) ─────────────────────────

export interface AgentIdentityReg {
  tokenId:      number;
  owner:        string;   // wallet address
  name:         string;
  description:  string;
  mcpEndpoint:  string;
  tags:         string[];
  registeredAt: number;
  updatedAt:    number;
}

export interface AgentRepSummary {
  agentId:         string;  // wallet address
  tokenId:         number;
  score:           number;  // aggregated rep value (1e18 denominator, floating)
  feedbackCount:   number;
  citationScore:   number;  // from KV leaderboard (incremented per citation)
  bountiesClaimed: number;
  lastUpdated:     number;
}

export const KV_AGENT_IDENTITY  = (agentId: string) => `research:agent-identity:${agentId.toLowerCase()}`;
export const KV_AGENT_REP       = (agentId: string) => `research:agent-rep:${agentId.toLowerCase()}`;
export const KV_AGENT_REP_INDEX = ()                 => `research:agent-rep:__index__`;

export async function kvGetAgentIdentity(kv: any, agentId: string): Promise<AgentIdentityReg | null> {
  const val = await kv.get(KV_AGENT_IDENTITY(agentId));
  return val ? JSON.parse(val) : null;
}

export async function kvSetAgentIdentity(kv: any, reg: AgentIdentityReg): Promise<void> {
  await kv.put(KV_AGENT_IDENTITY(reg.owner), JSON.stringify(reg));
}

export async function kvGetAgentRep(kv: any, agentId: string): Promise<AgentRepSummary | null> {
  const val = await kv.get(KV_AGENT_REP(agentId));
  return val ? JSON.parse(val) : null;
}

export async function kvUpdateAgentRep(
  kv: any,
  agentId: string,
  tokenId: number,
  delta: { scoreDelta?: number; feedbackDelta?: number; bountyDelta?: number; citationDelta?: number },
): Promise<void> {
  const key  = KV_AGENT_REP(agentId);
  const prev = await kv.get(key);
  const rep: AgentRepSummary = prev ? JSON.parse(prev) : {
    agentId, tokenId, score: 0, feedbackCount: 0, citationScore: 0, bountiesClaimed: 0, lastUpdated: 0,
  };
  if (delta.scoreDelta    !== undefined) rep.score           += delta.scoreDelta;
  if (delta.feedbackDelta !== undefined) rep.feedbackCount   += delta.feedbackDelta;
  if (delta.bountyDelta   !== undefined) rep.bountiesClaimed += delta.bountyDelta;
  if (delta.citationDelta !== undefined) rep.citationScore   += delta.citationDelta;
  rep.tokenId     = tokenId;
  rep.lastUpdated = Math.floor(Date.now() / 1000);
  await kv.put(key, JSON.stringify(rep));

  // Keep a sorted global index for agent_reputation_list
  const idxKey = KV_AGENT_REP_INDEX();
  const idxRaw = await kv.get(idxKey);
  const idx: AgentRepSummary[] = idxRaw ? JSON.parse(idxRaw) : [];
  const existing = idx.findIndex(e => e.agentId.toLowerCase() === agentId.toLowerCase());
  if (existing >= 0) {
    idx[existing] = rep;
  } else {
    idx.push(rep);
  }
  idx.sort((a, b) => b.score - a.score);
  await kv.put(idxKey, JSON.stringify(idx));
}

export async function kvGetRepLeaderboard(kv: any, limit: number): Promise<AgentRepSummary[]> {
  const val = await kv.get(KV_AGENT_REP_INDEX());
  if (!val) return [];
  return (JSON.parse(val) as AgentRepSummary[]).slice(0, limit);
}

export function formatRepSummary(r: AgentRepSummary): string {
  const scoreStr = (r.score >= 0 ? '+' : '') + r.score.toFixed(4);
  return [
    `${r.agentId}  (tokenId: ${r.tokenId})`,
    `  score:    ${scoreStr}  (${r.feedbackCount} feedback${r.feedbackCount !== 1 ? 's' : ''})`,
    `  citations: ${r.citationScore}  |  bounties: ${r.bountiesClaimed}`,
  ].join('\n');
}

export function formatBounty(b: ResearchBounty): string {
  const lines = [
    `[${b.id}] ${b.title}  — ${b.status.toUpperCase()}`,
    `  topic:    ${b.topic}${b.directionCategory ? ` / ${b.directionCategory}` : ''}`,
    `  reward:   ${b.reward ?? '(no escrow)'}`,
  ];
  if (b.metricName && b.minMetricDelta !== undefined)
    lines.push(`  requires: ${b.metricName} Δ ≤ ${b.minMetricDelta}`);
  if (b.deadline) lines.push(`  deadline: ${new Date(b.deadline * 1000).toISOString()}`);
  lines.push(`  ${b.description}`);
  if (b.status !== 'open') {
    lines.push(`  claimed by: ${b.claimedBy ?? 'unknown'}  →  ${b.claimedTxHash ?? ''}`);
  }
  return lines.join('\n');
}
