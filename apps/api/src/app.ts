import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context.js';
import { createErrorHandler, notFoundHandler } from './platform/errors.js';
import { approvalRoutes } from './modules/approvals/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { calendarRoutes } from './modules/calendar/routes.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { eventRoutes } from './modules/events/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import { userRoutes } from './modules/users/routes.js';

export function createApp(ctx: AppContext): Express {
  const { config, logger } = ctx;
  const app = express();

  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id =
          typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url?.startsWith('/api/health') ?? false },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      // Log method/url/status only; headers (cookies, tokens) are not serialized.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.CORS_ORIGINS.includes(origin)),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/health', healthRoutes(ctx));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/users', userRoutes(ctx));
  app.use('/api/departments', departmentRoutes(ctx));
  app.use('/api/calendar', calendarRoutes(ctx));
  app.use('/api/events', eventRoutes(ctx));
  app.use('/api/events', approvalRoutes(ctx));

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
