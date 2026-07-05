/**
 * Health Check API
 *
 * GET /api/health - Check system health status
 *
 * Returns health status for various system components:
 * - Database connectivity
 * - Sessions volume writability
 * - Schema version (code vs. applied migrations — see schemaVersion below)
 */

import { createFileRoute } from '@tanstack/react-router';
import { access, constants } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface HealthCheck {
  status: 'ok' | 'error';
  message?: string;
}

/**
 * Code-vs-DB migration drift, without needing shell/SSH access to the host: `expected`
 * is how many migrations ship in THIS image's bundled `drizzle/meta/_journal.json`;
 * `applied` is how many drizzle has actually run against the connected database
 * (`drizzle.__drizzle_migrations` row count). `inSync` is the one field anyone
 * debugging "why does the UI look old" should check first. Best-effort: a DB hiccup
 * here must not affect the endpoint's overall status (see try/catch below) — this
 * field is diagnostic, not a liveness gate.
 */
interface SchemaVersionCheck {
  expected: number | null;
  applied: number | null;
  inSync: boolean | null;
  error?: string;
}

interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  /** Current running version — git SHA baked into the image at build time (FR1).
   * Used by the online auto-update flow to detect/poll the running version. */
  version: string;
  checks: {
    sessionsVolume: HealthCheck;
  };
  schemaVersion: SchemaVersionCheck;
}

async function checkSessionsVolume(): Promise<HealthCheck> {
  try {
    const root = process.env.CLAUDE_SESSIONS_ROOT || '/data/users';
    await access(root, constants.W_OK);
    return { status: 'ok' };
  } catch (error) {
    return {
      status: 'error',
      message: `Sessions volume not writable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

async function checkSchemaVersion(): Promise<SchemaVersionCheck> {
  try {
    const [{ db }, journalRaw] = await Promise.all([
      import('~/db/client'),
      readFile(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf-8'),
    ]);
    const expected: number = JSON.parse(journalRaw).entries.length;

    const { sql } = await import('drizzle-orm');
    const rows = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    const applied = Number(rows[0]?.count ?? 0);

    return { expected, applied, inSync: applied === expected };
  } catch (error) {
    // Soft failure: unreadable journal, DB unreachable, migrations table not yet
    // created, etc. Reported for visibility; never blocks the health endpoint.
    return {
      expected: null,
      applied: null,
      inSync: null,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => {
        const [checks, schemaVersion] = await Promise.all([
          (async () => ({ sessionsVolume: await checkSessionsVolume() }))(),
          checkSchemaVersion(),
        ]);

        const isHealthy = Object.values(checks).every((c) => c.status === 'ok');

        const healthStatus: HealthStatus = {
          status: isHealthy ? 'healthy' : 'unhealthy',
          timestamp: new Date().toISOString(),
          version: process.env.BUILD_SHA ?? 'dev',
          checks,
          schemaVersion,
        };

        return new Response(JSON.stringify(healthStatus), {
          status: isHealthy ? 200 : 503,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  },
});
