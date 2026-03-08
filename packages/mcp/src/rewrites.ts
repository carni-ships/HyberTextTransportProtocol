/**
 * rewrites.ts — Netlify-compatible _redirects and _headers parser and matcher.
 *
 * _redirects syntax (one rule per line):
 *   /from  /to  [statusCode]
 *   /blog/*  /posts/:splat  301
 *   /api/:id  /v2/api/:id  200
 *
 * _headers syntax:
 *   /path/*
 *     Header-Name: value
 */

export interface Redirect {
  from:   string;
  to:     string;
  status: number;
  force:  boolean;
}

export interface HeaderRule {
  path:    string;
  headers: Record<string, string>;
}

export function parseRedirects(content: string): Redirect[] {
  const results: Redirect[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [from, to, statusStr] = parts;
    if (!from || !to) continue;
    const force      = (statusStr ?? '').endsWith('!');
    const statusNum  = statusStr ? parseInt(statusStr.replace('!', ''), 10) : 301;
    if (!Number.isFinite(statusNum)) continue;
    results.push({ from, to, status: statusNum, force });
  }
  return results;
}

export function parseHeaders(content: string): HeaderRule[] {
  const results: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('  ') || line.startsWith('\t')) {
      if (!current) continue;
      const colonIdx = line.indexOf(':');
      if (colonIdx < 0) continue;
      const name  = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (name) current.headers[name] = value;
    } else {
      current = { path: line.trim(), headers: {} };
      results.push(current);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

function matchRedirectPattern(
  pattern: string,
  reqPath: string,
): { params: Record<string, string>; splat: string } | null {
  if (pattern.includes('*')) {
    const starIdx = pattern.indexOf('*');
    const before  = pattern.slice(0, starIdx);
    const after   = pattern.slice(starIdx + 1);
    if (!reqPath.startsWith(before)) return null;
    const rest = reqPath.slice(before.length);
    if (after && !rest.endsWith(after)) return null;
    const splat = after ? rest.slice(0, -after.length) : rest;
    return { params: {}, splat };
  }

  const patParts = pattern.split('/').filter(Boolean);
  const reqParts = reqPath.split('/').filter(Boolean);
  if (patParts.length !== reqParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patParts.length; i++) {
    if (patParts[i].startsWith(':')) {
      params[patParts[i].slice(1)] = reqParts[i];
    } else if (patParts[i] !== reqParts[i]) {
      return null;
    }
  }
  return { params, splat: '' };
}

function applyTo(to: string, params: Record<string, string>, splat: string): string {
  let result = to;
  for (const [k, v] of Object.entries(params)) {
    result = result.replaceAll(`:${k}`, v);
  }
  return result.replace(':splat', splat).replace('*', splat);
}

function matchHeadersPath(pattern: string, reqPath: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === reqPath || reqPath.startsWith(pattern.replace(/\/$/, '') + '/');
  }
  const starIdx = pattern.indexOf('*');
  const before  = pattern.slice(0, starIdx);
  const after   = pattern.slice(starIdx + 1);
  if (!reqPath.startsWith(before)) return false;
  if (after) return reqPath.endsWith(after);
  return true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RewriteResult {
  redirect?: { location: string; status: number };
  headers?:  Record<string, string>;
}

export function applyRewrites(
  reqPath:     string,
  redirects:   Redirect[],
  headerRules: HeaderRule[],
): RewriteResult {
  for (const rule of redirects) {
    const match = matchRedirectPattern(rule.from, reqPath);
    if (match) {
      const location = applyTo(rule.to, match.params, match.splat);
      return { redirect: { location, status: rule.status } };
    }
  }

  const headers: Record<string, string> = {};
  for (const rule of headerRules) {
    if (matchHeadersPath(rule.path, reqPath)) {
      Object.assign(headers, rule.headers);
    }
  }
  return Object.keys(headers).length > 0 ? { headers } : {};
}
