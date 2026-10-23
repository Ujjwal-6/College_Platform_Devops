import { Router } from 'express';
import type { AppContext } from '../../context.js';

export function healthRoutes(ctx: AppContext): Router {
  const router = Router();

  /** Liveness: the process is up. */
  router.get('/', (_req, res) => {
    res.json({ status: 'ok' });
  });

  /** Readiness: dependencies are reachable. Returns 503 so load balancers stop routing here. */
  router.get('/ready', async (_req, res) => {
    try {
      await ctx.pool.query('SELECT 1');
      res.json({ status: 'ok', checks: { database: 'up' } });
    } catch {
      res.status(503).json({ status: 'unavailable', checks: { database: 'down' } });
    }
  });

  return router;
}
