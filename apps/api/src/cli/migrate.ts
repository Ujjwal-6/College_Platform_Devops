import { loadDotEnv } from '../config.js';
import { runMigrations } from '../platform/migrate.js';

// Usage: npm run migrate            -> apply all pending migrations
//        npm run migrate -- down [n] -> revert the last n migrations (default 1)
loadDotEnv();
const direction = process.argv[2] === 'down' ? 'down' : 'up';
const count = process.argv[3] ? Number(process.argv[3]) : undefined;
if (count !== undefined && (!Number.isInteger(count) || count < 1)) {
  console.error('Migration count must be a positive integer');
  process.exit(1);
}

try {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (copy .env.example to .env)');
  await runMigrations(databaseUrl, direction, count);
  console.log(`Migrations (${direction}) completed`);
} catch (err) {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
