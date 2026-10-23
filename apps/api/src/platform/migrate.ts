import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/** Applies (or reverts) versioned SQL migrations from apps/api/migrations. */
export async function runMigrations(
  databaseUrl: string,
  direction: 'up' | 'down' = 'up',
  count?: number,
): Promise<void> {
  await runner({
    databaseUrl,
    dir: migrationsDir,
    migrationsTable: 'pgmigrations',
    direction,
    count: count ?? (direction === 'up' ? Infinity : 1),
    log: () => undefined,
  });
}
