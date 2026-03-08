/**
 * detect.ts — Framework detection, build runner, and hybertext.config.js support.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// hybertext.config.js
// ---------------------------------------------------------------------------

export interface HyberConfig {
  /** Override the build command (e.g. 'npm run build:static') */
  build?:     string;
  /** Override the output directory (e.g. 'dist/static') */
  out?:       string;
  /** Alias to register after deploy */
  name?:      string;
  /** Use manifest v4 (per-file addressing, incremental deploys) */
  v4?:        boolean;
}

export function loadHyberConfig(dir: string): HyberConfig | null {
  for (const f of ['hybertext.config.js', 'hybertext.config.cjs']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require(p);
      return mod.default ?? mod;
    } catch { /* ignore */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

export interface FrameworkInfo {
  name:     string;
  buildCmd: string;
  outDir:   string;
  /** Warning to print before building (e.g. Next.js missing static export config) */
  warn?:    string;
}

const OUT_CANDIDATES = ['dist', 'out', 'build', 'public', '_site', 'www', '.output/public'];

export function detectFramework(dir: string): FrameworkInfo | null {
  // hybertext.config.js overrides everything
  const hcfg = loadHyberConfig(dir);
  if (hcfg?.build) {
    return { name: 'custom (hybertext.config.js)', buildCmd: hcfg.build, outDir: hcfg.out ?? detectOutDir(dir) };
  }

  let pkg: Record<string, any> = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { /* ok */ }
  const deps    = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};

  // Ordered by specificity (most specific first)
  if (deps['astro'])           return { name: 'Astro',     buildCmd: 'astro build',          outDir: 'dist' };
  if (deps['@sveltejs/kit'])   return { name: 'SvelteKit', buildCmd: 'vite build',            outDir: 'build' };
  if (deps['gatsby'])          return { name: 'Gatsby',    buildCmd: 'gatsby build',          outDir: 'public' };
  if (deps['@11ty/eleventy'])  return { name: 'Eleventy',  buildCmd: 'eleventy',              outDir: '_site' };
  if (deps['react-scripts'])   return { name: 'CRA',       buildCmd: 'react-scripts build',   outDir: 'build' };
  if (deps['nuxt'])            return { name: 'Nuxt',      buildCmd: 'nuxt generate',         outDir: '.output/public' };
  if (deps['vite'])            return { name: 'Vite',      buildCmd: 'vite build',            outDir: 'dist' };
  if (deps['next']) {
    const warn = hasNextStaticExport(dir)
      ? undefined
      : 'Add output: "export" to next.config.js for static export';
    return { name: 'Next.js', buildCmd: 'next build', outDir: 'out', warn };
  }
  if (fs.existsSync(path.join(dir, 'hugo.toml')) || fs.existsSync(path.join(dir, 'config.toml'))) {
    return { name: 'Hugo', buildCmd: 'hugo', outDir: 'public' };
  }
  if (fs.existsSync(path.join(dir, '_config.yml'))) {
    return { name: 'Jekyll', buildCmd: 'bundle exec jekyll build', outDir: '_site' };
  }
  if (scripts.build) {
    return { name: 'custom', buildCmd: 'npm run build', outDir: detectOutDir(dir) };
  }
  return null;
}

function hasNextStaticExport(dir: string): boolean {
  for (const f of ['next.config.js', 'next.config.mjs', 'next.config.ts']) {
    try {
      const txt = fs.readFileSync(path.join(dir, f), 'utf8');
      if (txt.includes("output: 'export'") || txt.includes('output: "export"')) return true;
    } catch { /* ok */ }
  }
  return false;
}

export function detectOutDir(dir: string): string {
  for (const d of OUT_CANDIDATES) {
    if (fs.existsSync(path.join(dir, d))) return d;
  }
  return 'dist';
}

// ---------------------------------------------------------------------------
// Build runner
// ---------------------------------------------------------------------------

export async function runBuild(cwd: string, cmd: string): Promise<void> {
  const [bin, ...args] = cmd.split(/\s+/);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: 'inherit', shell: true });
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Build process exited with code ${code}`));
    });
    child.on('error', err => reject(new Error(`Failed to start build: ${err.message}`)));
  });
}
