import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';

const createSchema = z.object({ name: z.string().trim().min(2).max(100) }).strict();

export function departmentRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  router.get('/', async (_req, res) => {
    const { rows } = await ctx.pool.query('SELECT id, name FROM departments ORDER BY name');
    res.json({ data: rows });
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const body = parse(createSchema, req.body);
    try {
      const department = await withTx(ctx.pool, async (tx) => {
        const { rows } = await tx.query(
          'INSERT INTO departments (name) VALUES ($1) RETURNING id, name',
          [body.name],
        );
        await recordAudit(tx, {
          actorId: req.user!.id,
          action: 'department.created',
          targetType: 'department',
          targetId: rows[0].id as string,
          ...requestMeta(req),
        });
        return rows[0];
      });
      res.status(201).json({ data: department });
    } catch (err) {
      if (isUniqueViolation(err))
        throw errors.conflict('DEPARTMENT_EXISTS', 'A department with this name already exists');
      throw err;
    }
  });

  return router;
}
