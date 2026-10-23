import { buildContext } from './build-context.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { registerNotificationHandlers } from './modules/notifications/notify.js';
import { JobWorker } from './platform/jobs/worker.js';

loadDotEnv();
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const ctx = buildContext(config);
const worker = new JobWorker({
  pool: ctx.pool,
  logger: ctx.logger,
  lockSeconds: config.JOB_LOCK_SECONDS,
  backoffBaseSeconds: config.JOB_BACKOFF_BASE_SECONDS,
  pollIntervalMs: config.JOB_POLL_INTERVAL_MS,
});
// Features register their handlers here (certificates, gate passes, post-event reports, ...).
registerNotificationHandlers(worker, ctx.mailer);

worker.start();
ctx.logger.info('job worker started');

async function shutdown(signal: string) {
  ctx.logger.info({ signal }, 'worker shutting down');
  await worker.stop();
  await ctx.pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
