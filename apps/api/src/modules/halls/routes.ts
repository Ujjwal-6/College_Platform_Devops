import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as repo from './repository.js';

/** Facilities are short lower-case tags; duplicates and blanks are dropped. */
export const facilitiesSchema = z
  .array(z.string().trim().toLowerCase().min(1).max(40))
  .max(30)
  .transform((tags) => [...new Set(tags)]);

const fields = {
  name: z.string().trim().min(2).max(100),
  location: z.string().trim().max(200),
  capacity: z.number().int().min(1).max(100_000),
  facilities: facilitiesSchema,
  description: z.string().trim().max(2000),
  isActive: z.boolean(),
};
const createSchema = z
  .object({
    name: fields.name,
    location: fields.location.default(''),
    capacity: fields.capacity,
    facilities: fields.facilities.default([]),
    description: fields.description.default(''),
    isActive: fields.isActive.default(true),
  })
  .strict();
const patchSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const idParams = z.object({ id: z.string().uuid() }).strict();
const listQuery = z.object({ includeInactive: z.enum(['true', 'false']).optional() }).strict();

/** Hall catalogue. Everyone signed in can read it (organizers choose from it); only admins change it. */
export function hallRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  const nameTaken = (err: unknown): never => {
    if (isUniqueViolation(err))
      throw errors.conflict('HALL_NAME_TAKEN', 'A hall with this name already exists');
    throw err;
  };

  router.get('/', async (req, res) => {
    const q = parse(listQuery, req.query);
    const includeInactive = req.user!.roles.includes('admin') && q.includeInactive === 'true';
    res.json({ data: await repo.list(ctx.pool, { includeInactive }) });
  });

  router.get('/:id', async (req, res) => {
    const { id } = parse(idParams, req.params);
    const hall = await repo.getById(ctx.pool, id);
    if (!hall || (!hall.isActive && !req.user!.roles.includes('admin')))
      throw errors.notFound('Hall');
    res.json({ data: hall });
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const body = parse(createSchema, req.body);
    try {
      const hall = await withTx(ctx.pool, async (tx) => {
        const created = await repo.insert(tx, body);
        await recordAudit(tx, {
          actorId: req.user!.id,
          action: 'hall.created',
          targetType: 'hall',
          targetId: created.id,
          metadata: { capacity: created.capacity },
          ...requestMeta(req),
        });
        return created;
      });
      res.status(201).json({ data: hall });
    } catch (err) {
      nameTaken(err);
    }
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(patchSchema, req.body);
    try {
      const hall = await withTx(ctx.pool, async (tx) => {
        const before = await repo.getById(tx, id, 'update');
        if (!before) throw errors.notFound('Hall');
        const updated = await repo.update(tx, id, { ...before, ...patch });
        await recordAudit(tx, {
          actorId: req.user!.id,
          action: 'hall.updated',
          targetType: 'hall',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
          ...requestMeta(req),
        });
        return updated;
      });
      res.json({ data: hall });
    } catch (err) {
      nameTaken(err);
    }
  });

  return router;
}
