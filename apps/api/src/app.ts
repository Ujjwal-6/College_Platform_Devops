import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { AppContext } from './context.js';
import { createErrorHandler, notFoundHandler } from './platform/errors.js';
import { adminRoutes } from './modules/admin/routes.js';
import { approvalRoutes } from './modules/approvals/routes.js';
import { checkInRoutes, eventAttendanceRoutes, passRoutes } from './modules/attendance/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { bookingRoutes } from './modules/bookings/routes.js';
import { registerBookingHooks } from './modules/bookings/hooks.js';
import { calendarRoutes } from './modules/calendar/routes.js';
import { departmentRoutes } from './modules/departments/routes.js';
import { eventRoutes } from './modules/events/routes.js';
import { hallRoutes } from './modules/halls/routes.js';
import { healthRoutes } from './modules/health/routes.js';
import {
  eventRegistrationRoutes,
  myRegistrationRoutes,
  teamRoutes,
} from './modules/registrations/routes.js';
import { registerAttendanceGuards } from './modules/attendance/hooks.js';
import {
  certificateRoutes,
  certificateTemplateRoutes,
  eventCertificateRoutes,
} from './modules/certificates/routes.js';
import { feedbackRoutes } from './modules/feedback/routes.js';
import { registerRegistrationHooks } from './modules/registrations/hooks.js';
import { reservationRoutes, resourceRoutes } from './modules/resources/routes.js';
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
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api/departments', departmentRoutes(ctx));
  app.use('/api/calendar', calendarRoutes(ctx));
  app.use('/api/events', eventRoutes(ctx));
  app.use('/api/events', approvalRoutes(ctx));
  app.use('/api/events', eventRegistrationRoutes(ctx));
  app.use('/api/events', eventAttendanceRoutes(ctx));
  app.use('/api/events', eventCertificateRoutes(ctx));
  app.use('/api/events', feedbackRoutes(ctx));
  app.use('/api/certificates', certificateRoutes(ctx));
  app.use('/api/certificate-template', certificateTemplateRoutes(ctx));
  app.use('/api/check-in', checkInRoutes(ctx));
  app.use('/api/registrations', passRoutes(ctx));
  app.use('/api/teams', teamRoutes(ctx));
  app.use('/api/registrations', myRegistrationRoutes(ctx));
  app.use('/api/halls', hallRoutes(ctx));
  app.use('/api/bookings', bookingRoutes(ctx));
  app.use('/api/resources', resourceRoutes(ctx));
  app.use('/api/resource-reservations', reservationRoutes(ctx));

  // Connect other features to the event lifecycle (one line per feature; see docs/event-contract.md).
  registerBookingHooks(ctx);
  registerRegistrationHooks(ctx);
  registerAttendanceGuards();

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));
  return app;
}
