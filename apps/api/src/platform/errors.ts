import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from 'pino';

/** Error that is safe to show to API clients. Anything else becomes a generic 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const errors = {
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details),
  unauthenticated: (message = 'Authentication required') =>
    new AppError(401, 'UNAUTHENTICATED', message),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'),
  invalidRefreshToken: () =>
    new AppError(401, 'INVALID_REFRESH_TOKEN', 'Session expired, please sign in again'),
  forbidden: (message = 'You do not have permission to perform this action') =>
    new AppError(403, 'FORBIDDEN', message),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  tooManyRequests: (message = 'Too many requests, please try again later') =>
    new AppError(429, 'RATE_LIMITED', message),
};

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/** One error format for the whole API: { error: { code, message, details?, requestId } }. */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = typeof req.id === 'string' ? req.id : undefined;
    let status = 500;
    let body: ErrorBody['error'] = {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      requestId,
    };

    if (err instanceof AppError) {
      status = err.status;
      body = { code: err.code, message: err.message, details: err.details, requestId };
    } else if (err instanceof ZodError) {
      status = 400;
      body = {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: zodDetails(err),
        requestId,
      };
    } else if (isHttpError(err)) {
      // body-parser errors (malformed JSON, payload too large)
      status = err.status;
      body = {
        code: err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: err.type === 'entity.too.large' ? 'Request body too large' : 'Malformed request',
        requestId,
      };
    }

    if (status >= 500) {
      logger.error({ err, requestId }, 'unhandled error');
    }
    res.status(status).json({ error: body } satisfies ErrorBody);
  };
}

export function zodDetails(err: ZodError): { path: string; message: string }[] {
  // Only paths and messages are returned, never the submitted values (they may be passwords).
  return err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

function isHttpError(err: unknown): err is { status: number; type: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'status' in err &&
    'type' in err &&
    typeof (err as { status: unknown }).status === 'number' &&
    (err as { status: number }).status >= 400 &&
    (err as { status: number }).status < 500
  );
}
