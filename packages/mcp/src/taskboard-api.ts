/**
 * Taskboard REST API — serves the Linear-style human dashboard.
 * All reads are public (no auth).
 * All writes use the gateway's own PRIVATE_KEY (same as MCP tool writes).
 *
 * Routes:
 *   GET  /api/taskboard/:ws/tasks[?project=&status=&priority=&milestone=&limit=]
 *   GET  /api/taskboard/:ws/tasks/:id
 *   POST /api/taskboard/:ws/tasks
 *   PATCH /api/taskboard/:ws/tasks/:id
 *   POST /api/taskboard/:ws/tasks/:id/comments
 *   GET  /api/taskboard/:ws/projects
 *   GET  /api/taskboard/:ws/milestones
 *   POST /api/taskboard/:ws/milestones
 *   PATCH /api/taskboard/:ws/milestones/:id
 */

import { HyberDBClient } from '@hybertext/db';
import type { Env } from './upload.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function dbClient(rpcUrl: string, env: Env, write = false): HyberDBClient {
  if (write && !env.PRIVATE_KEY) throw new Error('PRIVATE_KEY not configured');
  return new HyberDBClient({
    rpcUrl,
    contractAddress: env.HYBERDB_ADDRESS as `0x${string}`,
    ...(write && env.PRIVATE_KEY ? { privateKey: env.PRIVATE_KEY as `0x${string}` } : {}),
  });
}

async function nextSeq(kv: any, workspace: string, type: string): Promise<number> {
  const key = `taskboard:${workspace}:${type}_seq`;
  const raw = await kv.get(key);
  const n   = (raw ? parseInt(raw, 10) : 0) + 1;
  await kv.put(key, String(n));
  return n;
}

export async function handleTaskboardApi(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response | null> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // /api/taskboard/:workspace/...
  const m = url.pathname.match(/^\/api\/taskboard\/([^/]+)\/?(.*)$/);
  if (!m) return null;

  const workspace = decodeURIComponent(m[1]);
  const rest      = m[2] ?? ''; // e.g. "tasks", "tasks/T-5", "milestones", etc.
  const rpcUrl    = env.BERACHAIN_RPC ?? 'https://rpc.berachain.com';
  const kv        = env.EDGE_KV as any;

  // ── GET /api/taskboard/:ws/projects ──────────────────────────────────────
  if (rest === 'projects' && request.method === 'GET') {
    if (!env.HYBERDB_ADDRESS) return json({ error: 'HyberDB not configured' }, 503);
    try {
      const result = await dbClient(rpcUrl, env).getAll(`${workspace}/projects`, {
        orderBy: 'createdAt', orderDir: 'asc', limit: 100,
      });
      return json({ projects: result.records.map(r => r.val) });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /api/taskboard/:ws/milestones ─────────────────────────────────────
  if (rest === 'milestones' && request.method === 'GET') {
    if (!kv) return json({ milestones: [] });
    const raw = await kv.get(`taskboard:${workspace}:milestones`);
    return json({ milestones: raw ? JSON.parse(raw) : [] });
  }

  // ── POST /api/taskboard/:ws/milestones ────────────────────────────────────
  if (rest === 'milestones' && request.method === 'POST') {
    if (!kv) return json({ error: 'KV not configured' }, 503);
    try {
      const body = await request.json() as any;
      const n    = await nextSeq(kv, workspace, 'milestone');
      const ms   = {
        id:          `M-${n}`,
        workspace,
        title:       body.title ?? 'Untitled Milestone',
        description: body.description ?? '',
        status:      'active',
        dueDate:     body.dueDate ?? null,
        createdAt:   Math.floor(Date.now() / 1000),
      };
      const prevRaw = await kv.get(`taskboard:${workspace}:milestones`);
      const list    = prevRaw ? JSON.parse(prevRaw) : [];
      list.push(ms);
      await kv.put(`taskboard:${workspace}:milestones`, JSON.stringify(list));
      return json(ms, 201);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── PATCH /api/taskboard/:ws/milestones/:id ───────────────────────────────
  const msMatch = rest.match(/^milestones\/(.+)$/);
  if (msMatch && request.method === 'PATCH') {
    if (!kv) return json({ error: 'KV not configured' }, 503);
    try {
      const msId    = msMatch[1];
      const body    = await request.json() as any;
      const prevRaw = await kv.get(`taskboard:${workspace}:milestones`);
      const list: any[] = prevRaw ? JSON.parse(prevRaw) : [];
      const idx     = list.findIndex(ms => ms.id === msId);
      if (idx < 0) return json({ error: 'Milestone not found' }, 404);
      Object.assign(list[idx], body);
      await kv.put(`taskboard:${workspace}:milestones`, JSON.stringify(list));
      return json(list[idx]);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /api/taskboard/:ws/tasks ──────────────────────────────────────────
  if (rest === 'tasks' && request.method === 'GET') {
    if (!env.HYBERDB_ADDRESS) return json({ error: 'HyberDB not configured' }, 503);
    try {
      const where: Record<string, unknown> = {};
      const p = url.searchParams.get('project');
      const s = url.searchParams.get('status');
      const r = url.searchParams.get('priority');
      const ms = url.searchParams.get('milestone');
      const a = url.searchParams.get('assignee');
      if (p)  where.project     = p;
      if (s)  where.status      = s;
      if (r)  where.priority    = r;
      if (ms) where.milestoneId = ms;
      if (a)  where.assignee    = a;
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '200'), 500);
      const result = await dbClient(rpcUrl, env).getAll(`${workspace}/tasks`, {
        where:    Object.keys(where).length ? where as any : undefined,
        orderBy:  'updatedAt',
        orderDir: 'desc',
        limit,
      });
      return json({ tasks: result.records.map(r => r.val), total: result.records.length });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── GET /api/taskboard/:ws/tasks/:id ──────────────────────────────────────
  const taskMatch = rest.match(/^tasks\/([^/]+)$/);
  if (taskMatch && request.method === 'GET') {
    if (!env.HYBERDB_ADDRESS) return json({ error: 'HyberDB not configured' }, 503);
    try {
      const taskId = taskMatch[1];
      const client = dbClient(rpcUrl, env);
      const [taskVal, commentsResult] = await Promise.all([
        client.get(`${workspace}/tasks`, taskId),
        client.getAll(`${workspace}/comments`, {
          where: { taskId } as any, orderBy: 'createdAt', orderDir: 'asc',
        }),
      ]);
      if (!taskVal) return json({ error: 'Task not found' }, 404);
      return json({ task: taskVal, comments: commentsResult.records.map(r => r.val) });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── POST /api/taskboard/:ws/tasks ─────────────────────────────────────────
  if (rest === 'tasks' && request.method === 'POST') {
    if (!env.HYBERDB_ADDRESS || !env.PRIVATE_KEY || !kv) {
      return json({ error: 'Gateway not configured for writes' }, 503);
    }
    try {
      const body = await request.json() as any;
      const n    = await nextSeq(kv, workspace, 'task');
      const id   = `T-${n}`;
      const now  = Math.floor(Date.now() / 1000);
      const task = {
        id,
        project:      body.project,
        title:        body.title,
        description:  body.description ?? '',
        status:       'todo',
        priority:     body.priority ?? 'medium',
        assignee:     body.assignee ?? null,
        labels:       body.labels ?? [],
        milestoneId:  body.milestoneId ?? null,
        dueDate:      body.dueDate ?? null,
        createdBy:    null,
        createdAt:    now,
        updatedAt:    now,
        resultTxHash: null,
        parentId:     body.parentId ?? null,
      };
      const txHash = await dbClient(rpcUrl, env, true).set(`${workspace}/tasks`, id, task as any);
      return json({ task, txHash }, 201);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── PATCH /api/taskboard/:ws/tasks/:id ────────────────────────────────────
  if (taskMatch && request.method === 'PATCH') {
    if (!env.HYBERDB_ADDRESS || !env.PRIVATE_KEY) {
      return json({ error: 'Gateway not configured for writes' }, 503);
    }
    try {
      const taskId  = taskMatch[1];
      const body    = await request.json() as any;
      const updates: Record<string, unknown> = { updatedAt: Math.floor(Date.now() / 1000) };
      for (const f of ['status','priority','title','description','labels','assignee','milestoneId','dueDate','parentId']) {
        if (body[f] !== undefined) updates[f] = body[f];
      }
      const txHash = await dbClient(rpcUrl, env, true).merge(`${workspace}/tasks`, taskId, updates as any);
      return json({ taskId, updates, txHash });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  // ── POST /api/taskboard/:ws/tasks/:id/comments ───────────────────────────
  const commentMatch = rest.match(/^tasks\/([^/]+)\/comments$/);
  if (commentMatch && request.method === 'POST') {
    if (!env.HYBERDB_ADDRESS || !env.PRIVATE_KEY || !kv) {
      return json({ error: 'Gateway not configured for writes' }, 503);
    }
    try {
      const taskId  = commentMatch[1];
      const body    = await request.json() as any;
      const n       = await nextSeq(kv, workspace, 'comment');
      const id      = `C-${n}`;
      const now     = Math.floor(Date.now() / 1000);
      const comment = { id, taskId, author: body.author ?? null, body: body.body, createdAt: now };
      const txHash  = await dbClient(rpcUrl, env, true).set(
        `${workspace}/comments`, `${taskId}:${id}`, comment as any,
      );
      return json({ comment, txHash }, 201);
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }

  return null; // no route matched
}
