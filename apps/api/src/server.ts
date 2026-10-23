import { createApp } from './app.js';
import { buildContext } from './build-context.js';
import { ConfigError, loadConfig, loadDotEnv } from './config.js';

loadDotEnv();
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const ctx = buildContext(config);
const server = createApp(ctx).listen(config.PORT, () => {
  ctx.logger.info({ port: config.PORT, env: config.NODE_ENV }, 'api listening');
});

async function shutdown(signal: string) {
  ctx.logger.info({ signal }, 'shutting down');
  server.close(async () => {
    await ctx.pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
