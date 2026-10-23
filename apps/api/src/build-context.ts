import path from 'node:path';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createPool } from './platform/db.js';
import { createLogger } from './platform/logger.js';
import { SmtpMailer } from './platform/mailer.js';
import { LocalFileStorage } from './platform/storage/index.js';

/** Production wiring: real database, SMTP and local disk storage. */
export function buildContext(config: Config): AppContext {
  return {
    config,
    pool: createPool(config.DATABASE_URL),
    logger: createLogger(config),
    mailer: new SmtpMailer(config),
    storage: new LocalFileStorage(path.resolve(config.STORAGE_DIR)),
  };
}
