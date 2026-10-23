import type { Pool } from 'pg';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { Mailer } from './platform/mailer.js';
import type { FileStorage } from './platform/storage/index.js';

/** Everything the app needs, passed in explicitly so tests can substitute real or fake parts. */
export interface AppContext {
  config: Config;
  pool: Pool;
  logger: Logger;
  mailer: Mailer;
  storage: FileStorage;
}
