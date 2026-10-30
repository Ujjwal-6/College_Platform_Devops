// Creates .env from .env.example with freshly generated secrets. Never overwrites an existing .env.
//   npm run setup:env
//   POSTGRES_PORT=5433 npm run setup:env    (if 5432 is already in use on your machine)
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(root, '.env.example');
const target = path.join(root, '.env');

if (existsSync(target)) {
  console.log('.env already exists; leaving it unchanged.');
  process.exit(0);
}

copyFileSync(example, target);
const dbPassword = randomBytes(18).toString('base64url');
const jwtSecret = randomBytes(48).toString('base64url');
const port = process.env.POSTGRES_PORT ?? '5432';
const metricsToken = randomBytes(24).toString('base64url');

let text = readFileSync(target, 'utf8')
  .replaceAll('__GENERATED_DB_PASSWORD__', dbPassword)
  .replaceAll('__GENERATED_JWT_SECRET__', jwtSecret)
  .replaceAll('__GENERATED_METRICS_TOKEN__', metricsToken)
  .replaceAll('POSTGRES_PORT=5432', `POSTGRES_PORT=${port}`)
  .replaceAll('localhost:5432', `localhost:${port}`);
writeFileSync(target, text, { mode: 0o600 });
// Prometheus (docker compose --profile monitoring) reads the same token from a file, never from its config.
mkdirSync(path.join(root, 'infra/monitoring'), { recursive: true });
writeFileSync(path.join(root, 'infra/monitoring/metrics-token'), metricsToken, { mode: 0o600 });
console.log(
  `Created .env with generated secrets (Postgres port ${port}). Set ADMIN_* before running create-admin.`,
);
