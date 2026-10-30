import { createServer } from 'node:http';
import { buildContext } from './build-context.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';
import { registerEventHooks } from './hooks.js';
import { closeEndedEvents } from './modules/events/autoclose.js';
import { registerGatePassHandlers } from './modules/attendance/gatepass.js';
import { registerCertificateHandlers } from './modules/certificates/handlers.js';
import { registerNotificationHandlers } from './modules/notifications/notify.js';
import { registerReportHandlers } from './modules/reports/handlers.js';
import { metricsReply } from './platform/metrics.js';
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
// The worker closes finished events, so it needs the same lifecycle hooks as the API (report, bookings, registrations).
registerEventHooks(ctx);
const worker = new JobWorker({
  pool: ctx.pool,
  logger: ctx.logger,
  lockSeconds: config.JOB_LOCK_SECONDS,
  backoffBaseSeconds: config.JOB_BACKOFF_BASE_SECONDS,
  pollIntervalMs: config.JOB_POLL_INTERVAL_MS,
});
// Features register their handlers here (certificates, gate passes, post-event reports, ...).
registerNotificationHandlers(worker, ctx.mailer);
registerGatePassHandlers(worker, ctx);
registerCertificateHandlers(worker, ctx);
registerReportHandlers(worker, ctx);

worker.start();

// Finished events close themselves after a grace period (EVENT_AUTO_CLOSE_HOURS).
let closing = false;
const closeTimer = setInterval(() => {
  if (closing) return;
  closing = true;
  closeEndedEvents(ctx)
    .catch((err) => ctx.logger.error({ err }, 'automatic close run failed'))
    .finally(() => (closing = false));
}, config.EVENT_AUTO_CLOSE_INTERVAL_SECONDS * 1000);
ctx.logger.info('job worker started');

// The worker is a separate process, so it serves its own /metrics (job counters and timings) when asked to.
const metricsServer =
  config.WORKER_METRICS_PORT > 0
    ? createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/metrics') {
          res.statusCode = 404;
          res.end();
          return;
        }
        metricsReply(ctx.pool, config.METRICS_TOKEN, req.headers.authorization)
          .then((reply) => {
            res.writeHead(reply.status, { ...reply.headers, 'Content-Type': reply.contentType });
            res.end(reply.body);
          })
          .catch((err) => {
            ctx.logger.error({ err }, 'worker metrics failed');
            res.statusCode = 500;
            res.end();
          });
      }).listen(config.WORKER_METRICS_PORT, () =>
        ctx.logger.info({ port: config.WORKER_METRICS_PORT }, 'worker metrics listening'),
      )
    : null;

async function shutdown(signal: string) {
  ctx.logger.info({ signal }, 'worker shutting down');
  clearInterval(closeTimer);
  metricsServer?.close();
  await worker.stop();
  await ctx.pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
