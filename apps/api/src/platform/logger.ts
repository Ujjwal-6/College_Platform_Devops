import { pino, type Logger } from 'pino';
import type { Config } from '../config.js';

/** Structured JSON logs. Credentials and cookies are redacted before anything is written. */
export function createLogger(config: Pick<Config, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: config.NODE_ENV === 'test' ? 'silent' : config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.password',
        '*.currentPassword',
        '*.newPassword',
        '*.passwordHash',
        '*.token',
        '*.refreshToken',
        '*.accessToken',
      ],
      censor: '[redacted]',
    },
  });
}
