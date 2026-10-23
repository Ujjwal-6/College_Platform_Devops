import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { parse } from '../../platform/validate.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requestMeta } from '../auth/routes.js';
import { ROLES } from '../auth/types.js';
import * as service from './service.js';

const idParams = z.object({ id: z.string().uuid() }).strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
    role: z.enum(ROLES).optional(),
    isActive: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    departmentId: z.string().uuid().optional(),
  })
  .strict();
const rolesBody = z.object({ roles: service.rolesSchema }).strict();

export function userRoutes(ctx: AppContext): Router {
  const router = Router();
  router.use(requireAuth(ctx));

  // Admins manage all users. HODs may read users of their own department (department scope example).
  router.get('/', requireRole('admin', 'hod'), async (req, res) => {
    res.json(await service.listUsers(ctx, req.user!, parse(listQuery, req.query)));
  });

  router.get('/:id', requireRole('admin', 'hod'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ data: await service.getUser(ctx, req.user!, id) });
  });

  router.post('/', requireRole('admin'), async (req, res) => {
    const body = parse(service.createUserSchema, req.body);
    res
      .status(201)
      .json({ data: await service.createUser(ctx, req.user!, body, requestMeta(req)) });
  });

  router.patch('/:id', requireRole('admin'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(service.updateUserSchema, req.body);
    res.json({ data: await service.updateUser(ctx, req.user!, id, body, requestMeta(req)) });
  });

  router.put('/:id/roles', requireRole('admin'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    const body = parse(rolesBody, req.body);
    res.json({
      data: await service.setUserRoles(ctx, req.user!, id, body.roles, requestMeta(req)),
    });
  });

  router.post('/:id/deactivate', requireRole('admin'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ data: await service.setUserActive(ctx, req.user!, id, false, requestMeta(req)) });
  });

  router.post('/:id/activate', requireRole('admin'), async (req, res) => {
    const { id } = parse(idParams, req.params);
    res.json({ data: await service.setUserActive(ctx, req.user!, id, true, requestMeta(req)) });
  });

  return router;
}
