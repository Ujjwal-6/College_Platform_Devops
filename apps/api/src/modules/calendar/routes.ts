import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isForeignKeyViolation, withTx } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { parse } from '../../platform/validate.js';
import { recordAudit } from '../audit/audit.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import * as repo from './repository.js';
import { CALENDAR_TYPES } from './repository.js';
import { checkRange, DEFAULT_SEVERITY } from './service.js';

/** True only for real calendar dates in YYYY-MM-DD form (rejects 2030-02-31 and malformed text without throwing). */
function isRealDate(v: string): boolean {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(isRealDate, 'Not a real calendar date');

const entryFields = {
  type: z.enum(CALENDAR_TYPES),
  title: z.string().trim().min(2).max(150),
  startDate: isoDate,
  endDate: isoDate,
  severity: z.enum(['block', 'warn']),
  departmentId: z.string().uuid().nullable(),
  isActive: z.boolean(),
};
const createSchema = z
  .object({
    ...entryFields,
    severity: entryFields.severity.optional(),
    departmentId: entryFields.departmentId.optional(),
    isActive: entryFields.isActive.optional(),
  })
  .strict();
const patchSchema = z
  .object(entryFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const idParams = z.object({ id: z.string().uuid() }).strict();
const listQuery = z
  .object({
    from: isoDate.optional(),
    to: isoDate.optional(),
    includeInactive: z.enum(['true', 'false']).optional(),
  })
  .strict();
const checkQuery = z
  .object({
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    departmentId: z.string().uuid().optional(),
  })
  .strict();

export function calendarRoutes(ctx: AppContext): Router {
  const router = Router();
  const admin = requireRole('admin');
  router.use(requireAuth(ctx));

  const fail = (err: unknown): never => {
    if (isForeignKeyViolation(err))
      throw errors.validation([{ path: 'departmentId', message: 'Department does not exist' }]);
    throw err;
  };

  // Everyone can read the calendar (organizers plan around it); only admins see inactive entries.
  router.get('/entries', async (req, res) => {
    const q = parse(listQuery, req.query);
    const isAdmin = req.user!.roles.includes('admin');
    res.json({
      data: await repo.list(ctx.pool, {
        from: q.from,
        to: q.to,
        includeInactive: isAdmin && q.includeInactive === 'true',
      }),
    });
  });

  router.get('/check', async (req, res) => {
    const q = parse(checkQuery, req.query);
    const startAt = new Date(q.startAt);
    const endAt = new Date(q.endAt);
    if (endAt <= startAt)
      throw errors.validation([{ path: 'endAt', message: 'End must be after start' }]);
    res.json({
      data: await checkRange(ctx.pool, ctx.config.APP_TIMEZONE, {
        startAt,
        endAt,
        departmentId: q.departmentId ?? null,
      }),
    });
  });

  router.post('/entries', admin, async (req, res) => {
    const body = parse(createSchema, req.body);
    if (body.endDate < body.startDate)
      throw errors.validation([
        { path: 'endDate', message: 'End date must not be before start date' },
      ]);
    const input: repo.EntryInput = {
      type: body.type,
      title: body.title,
      startDate: body.startDate,
      endDate: body.endDate,
      severity: body.severity ?? DEFAULT_SEVERITY[body.type],
      departmentId: body.departmentId ?? null,
      isActive: body.isActive ?? true,
    };
    try {
      const entry = await withTx(ctx.pool, async (tx) => {
        const created = await repo.insert(tx, input, req.user!.id);
        await recordAudit(tx, {
          actorId: req.user!.id,
          action: 'calendar.entry_created',
          targetType: 'calendar_entry',
          targetId: created.id,
          metadata: { type: created.type, severity: created.severity },
          ...requestMeta(req),
        });
        return created;
      });
      const conflicts = await repo.findConflictingEvents(ctx.pool, ctx.config.APP_TIMEZONE, entry);
      res.status(201).json({ data: entry, conflicts });
    } catch (err) {
      fail(err);
    }
  });

  router.patch('/entries/:id', admin, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const patch = parse(patchSchema, req.body);
    try {
      const entry = await withTx(ctx.pool, async (tx) => {
        const before = await repo.getById(tx, id, true);
        if (!before) throw errors.notFound('Calendar entry');
        const next: repo.EntryInput = { ...before, ...patch };
        if (next.endDate < next.startDate)
          throw errors.validation([
            { path: 'endDate', message: 'End date must not be before start date' },
          ]);
        const updated = await repo.update(tx, id, next);
        await recordAudit(tx, {
          actorId: req.user!.id,
          action: 'calendar.entry_updated',
          targetType: 'calendar_entry',
          targetId: id,
          metadata: { fields: Object.keys(patch) },
          ...requestMeta(req),
        });
        return updated;
      });
      const conflicts = await repo.findConflictingEvents(ctx.pool, ctx.config.APP_TIMEZONE, entry);
      res.json({ data: entry, conflicts });
    } catch (err) {
      fail(err);
    }
  });

  router.delete('/entries/:id', admin, async (req, res) => {
    const { id } = parse(idParams, req.params);
    await withTx(ctx.pool, async (tx) => {
      const before = await repo.getById(tx, id, true);
      if (!before) throw errors.notFound('Calendar entry');
      await repo.remove(tx, id);
      await recordAudit(tx, {
        actorId: req.user!.id,
        action: 'calendar.entry_deleted',
        targetType: 'calendar_entry',
        targetId: id,
        metadata: { type: before.type, title: before.title },
        ...requestMeta(req),
      });
    });
    res.status(204).end();
  });

  // Events that currently overlap an entry (never modified by calendar changes).
  router.get('/entries/:id/conflicts', admin, async (req, res) => {
    const { id } = parse(idParams, req.params);
    const entry = await repo.getById(ctx.pool, id);
    if (!entry) throw errors.notFound('Calendar entry');
    res.json({ data: await repo.findConflictingEvents(ctx.pool, ctx.config.APP_TIMEZONE, entry) });
  });

  return router;
}
