import { loadDotEnv } from '../src/config.js';
import { runMigrations } from '../src/platform/migrate.js';

export default async function setup(): Promise<void> {
  loadDotEnv();
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');
  // Tests truncate tables, so refuse to run against anything that is not clearly a test database.
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!/test/i.test(dbName))
    throw new Error(`Refusing to run tests against database "${dbName}": name must contain "test"`);
  await runMigrations(url, 'up');
}
