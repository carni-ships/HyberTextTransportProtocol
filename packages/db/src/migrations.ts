/**
 * Schema migration runner for HyberDB namespaces.
 *
 * Migrations are numbered functions that run in order. The current version is
 * stored as a regular document in the namespace under the key `__schema_version`,
 * so it lives on-chain alongside your data and travels with the namespace head.
 *
 * Usage:
 *   import { createMigrations } from '@hybertext/db';
 *
 *   const migrate = createMigrations(db, 'myapp');
 *
 *   await migrate.run([
 *     {
 *       version: 1,
 *       description: 'Initial schema',
 *       up: async (db, ns) => {
 *         await db.set(ns, 'settings', { theme: 'light', lang: 'en' });
 *       },
 *     },
 *     {
 *       version: 2,
 *       description: 'Add user count',
 *       up: async (db, ns) => {
 *         await db.set(ns, 'stats', { userCount: 0 });
 *       },
 *     },
 *   ]);
 */

import type { HyberDBClient } from './client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Migration {
  /** Monotonically increasing integer. Runs are skipped if currentVersion >= this. */
  version:      number;
  /** Human-readable description (stored in the version doc). */
  description?: string;
  /** The migration body. Receives the db client and namespace name. */
  up: (db: HyberDBClient, namespace: string) => Promise<void>;
}

export interface MigrationResult {
  /** Schema version before migrations ran. */
  from:    number;
  /** Schema version after migrations ran. */
  to:      number;
  /** Versions that were executed this run. */
  ran:     number[];
  /** True if no migrations were pending. */
  upToDate: boolean;
}

export interface MigrationRunner {
  /** Return the current schema version (0 if the namespace is fresh or has no version doc). */
  currentVersion(): Promise<number>;

  /**
   * Run all pending migrations whose version > currentVersion, in ascending order.
   * Returns a summary of what was run. Never throws on individual migration failures —
   * throws on the first failure and stops further migrations.
   */
  run(migrations: Migration[]): Promise<MigrationResult>;

  /**
   * Validate that the namespace is at the expected version, throwing if not.
   * Useful as a startup assertion in long-running Workers.
   */
  assertVersion(expected: number): Promise<void>;
}

const VERSION_KEY = '__schema_version';

interface VersionDoc {
  version:     number;
  migratedAt:  string;
  description: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a migration runner bound to a specific namespace.
 *
 * @param db   A HyberDBClient instance
 * @param ns   The namespace to manage migrations for
 */
export function createMigrations(db: HyberDBClient, ns: string): MigrationRunner {
  async function currentVersion(): Promise<number> {
    try {
      const doc = await db.get(ns, VERSION_KEY) as VersionDoc | null;
      return doc?.version ?? 0;
    } catch {
      return 0;
    }
  }

  return {
    currentVersion,

    async run(migrations) {
      const sorted  = [...migrations].sort((a, b) => a.version - b.version);
      const current = await currentVersion();
      const pending = sorted.filter(m => m.version > current);

      if (pending.length === 0) {
        return { from: current, to: current, ran: [], upToDate: true };
      }

      // Validate: no version numbers skip (must be contiguous from current+1 or new namespace)
      const ran: number[] = [];
      let lastVersion = current;

      for (const migration of pending) {
        await migration.up(db, ns);

        // Record the new version as a doc so it's stored on-chain with the data
        const versionDoc: VersionDoc = {
          version:     migration.version,
          migratedAt:  new Date().toISOString(),
          description: migration.description ?? `Migration v${migration.version}`,
        };
        await db.set(ns, VERSION_KEY, versionDoc as unknown as import('./types').JsonValue);

        ran.push(migration.version);
        lastVersion = migration.version;
      }

      return { from: current, to: lastVersion, ran, upToDate: false };
    },

    async assertVersion(expected) {
      const current = await currentVersion();
      if (current !== expected) {
        throw new Error(
          `Schema version mismatch on namespace "${ns}": expected v${expected}, got v${current}. Run migrations first.`,
        );
      }
    },
  };
}
