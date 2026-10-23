import { loadConfig, loadDotEnv } from '../config.js';
import { buildContext } from '../build-context.js';
import { createUser } from '../modules/users/service.js';

// Creates the first administrator from environment variables. There are no default credentials.
//   ADMIN_EMAIL=... ADMIN_NAME=... ADMIN_PASSWORD=... npm run create-admin
loadDotEnv();
const { ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
if (!ADMIN_EMAIL || !ADMIN_NAME || !ADMIN_PASSWORD) {
  console.error(
    'Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD (12+ characters) in .env or the environment.',
  );
  process.exit(1);
}

const ctx = buildContext(loadConfig());
try {
  const user = await createUser(
    ctx,
    null,
    {
      email: ADMIN_EMAIL.trim().toLowerCase(),
      name: ADMIN_NAME.trim(),
      password: ADMIN_PASSWORD,
      roles: ['admin'],
      departmentId: null,
    },
    { bootstrap: true },
  );
  console.log(`Created admin ${user.email} (${user.id})`);
} catch (err) {
  console.error('Could not create admin:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await ctx.pool.end();
}
