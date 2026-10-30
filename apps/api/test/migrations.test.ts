import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/platform/migrate.js';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

/** Connection string for a throw-away database next to the test database (the name keeps "test" in it). */
function scratchUrls() {
  const url = new URL(process.env.TEST_DATABASE_URL!);
  const name = `${url.pathname.slice(1)}_migration_check`;
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const scratch = new URL(url);
  scratch.pathname = `/${name}`;
  return { name, admin: admin.toString(), scratch: scratch.toString() };
}

async function tables(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    return rows.map((r) => r.table_name as string);
  } finally {
    await client.end();
  }
}

describe('migration history', () => {
  it('uses unique, strictly increasing numeric prefixes', () => {
    const numbers = files.map((f) => Number(f.split('_')[0]));
    expect(numbers.every((n) => Number.isInteger(n))).toBe(true);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect([...numbers].sort((a, b) => a - b)).toEqual(numbers);
    expect(files.slice(0, 2)).toEqual(['001_identity.sql', '002_jobs.sql']); // the shipped foundation is untouched
  });

  it('applies to an empty database, reverts completely, and applies again', async () => {
    const { name, admin, scratch } = scratchUrls();
    const adminClient = new pg.Client({ connectionString: admin });
    await adminClient.connect();
    try {
      await adminClient.query(`DROP DATABASE IF EXISTS "${name}"`);
      await adminClient.query(`CREATE DATABASE "${name}"`);

      await runMigrations(scratch, 'up');
      const upTables = await tables(scratch);
      for (const table of [
        'users',
        'jobs',
        'events',
        'event_speakers',
        'event_approvals',
        'event_history',
        'calendar_entries',
        'halls',
        'resources',
        'hall_bookings',
        'booking_approvals',
        'booking_history',
        'resource_reservations',
        'teams',
        'registrations',
        'idempotency_keys',
        'attendance',
        'event_volunteers',
        'gate_passes',
        'event_attendance_settings',
        'certificates',
        'certificate_template',
        'event_report_inputs',
        'event_photos',
        'event_reports',
        'feedback',
        'budget_items',
      ]) {
        expect(upTables).toContain(table);
      }

      const check = new pg.Client({ connectionString: scratch });
      await check.connect();
      const constraint = await check.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'hall_bookings_no_overlap'",
      );
      const once = await check.query(
        "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'registrations_event_user_key'",
      );
      await check.end();
      // one registration per person per event is enforced by the database
      expect(once.rows[0]?.def).toBe('UNIQUE (event_id, user_id)');
      expect(constraint.rows[0]?.def).toMatch(
        /EXCLUDE USING gist \(hall_id WITH =, tstzrange\(start_at, end_at, '\[\)'::text\) WITH &&\) WHERE/,
      );

      await runMigrations(scratch, 'down', files.length);
      expect(await tables(scratch)).toEqual(['pgmigrations']);

      await runMigrations(scratch, 'up');
      expect(await tables(scratch)).toEqual(upTables);
    } finally {
      await adminClient.query(`DROP DATABASE IF EXISTS "${name}"`);
      await adminClient.end();
    }
  });
});
