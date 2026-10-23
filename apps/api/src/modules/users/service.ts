import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isUniqueViolation, withTx } from '../../platform/db.js';
import { errors } from '../../platform/errors.js';
import { recordAudit, type RequestMeta } from '../audit/audit.js';
import { hashPassword, passwordPolicyViolation } from '../auth/password.js';
import { revokeAllForUser } from '../auth/repository.js';
import { ROLES, type AuthUser, type Role } from '../auth/types.js';
import { hasRole } from '../auth/middleware.js';
import { notify } from '../notifications/notify.js';
import * as repo from './repository.js';

export const rolesSchema = z
  .array(z.enum(ROLES))
  .min(1)
  .max(ROLES.length)
  .refine((r) => new Set(r).size === r.length, 'Duplicate roles');

export const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().min(1).max(100),
    password: z.string().min(1).max(128),
    roles: rolesSchema,
    departmentId: z.string().uuid().nullable().optional(),
  })
  .strict();

export const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    departmentId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.departmentId !== undefined, 'Nothing to update');

type Input = z.infer<typeof createUserSchema>;

/** Faculty and HODs are scoped by department, so they must belong to one. */
function assertDepartmentRule(roles: Role[], departmentId: string | null | undefined): void {
  if (roles.some((r) => r === 'hod' || r === 'faculty') && !departmentId) {
    throw errors.validation([
      { path: 'departmentId', message: 'Faculty and HOD users must belong to a department' },
    ]);
  }
}

async function assertDepartmentExists(
  ctx: AppContext,
  departmentId: string | null | undefined,
): Promise<void> {
  if (departmentId && !(await repo.departmentExists(ctx.pool, departmentId))) {
    throw errors.validation([{ path: 'departmentId', message: 'Department does not exist' }]);
  }
}

export async function createUser(
  ctx: AppContext,
  actor: AuthUser | null,
  input: Input,
  meta: RequestMeta & { bootstrap?: boolean },
): Promise<repo.PublicUser> {
  const violation = passwordPolicyViolation(input.password, input.email);
  if (violation) throw errors.validation([{ path: 'password', message: violation }]);
  assertDepartmentRule(input.roles, input.departmentId);
  await assertDepartmentExists(ctx, input.departmentId);

  const passwordHash = await hashPassword(input.password, ctx.config);
  try {
    return await withTx(ctx.pool, async (tx) => {
      const id = await repo.insert(tx, {
        email: input.email,
        name: input.name,
        passwordHash,
        departmentId: input.departmentId ?? null,
      });
      await repo.setRoles(tx, id, input.roles);
      await recordAudit(tx, {
        actorId: actor?.id ?? null,
        action: 'user.created',
        targetType: 'user',
        targetId: id,
        metadata: { roles: input.roles, ...(meta.bootstrap ? { bootstrap: true } : {}) },
        requestId: meta.requestId,
        ip: meta.ip,
      });
      if (!meta.bootstrap) {
        await notify(tx, {
          type: 'account.created',
          to: input.email,
          data: { name: input.name, loginUrl: `${ctx.config.WEB_BASE_URL}/login` },
          key: `account.created:${id}`,
        });
      }
      return (await repo.getById(tx, id))!;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw errors.conflict('EMAIL_TAKEN', 'A user with this email already exists');
    throw err;
  }
}

export async function getUser(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
): Promise<repo.PublicUser> {
  const user = await repo.getById(ctx.pool, id);
  // HODs only see their own department; anything outside it looks like it does not exist.
  if (!user || (!hasRole(actor, 'admin') && user.departmentId !== actor.departmentId))
    throw errors.notFound('User');
  return user;
}

export async function listUsers(
  ctx: AppContext,
  actor: AuthUser,
  q: { limit: number; offset: number; role?: Role; isActive?: boolean; departmentId?: string },
) {
  const scoped = hasRole(actor, 'admin')
    ? q.departmentId
    : (actor.departmentId ?? '00000000-0000-0000-0000-000000000000');
  const { rows, total } = await repo.list(ctx.pool, { ...q, departmentId: scoped });
  return { data: rows, page: { limit: q.limit, offset: q.offset, total } };
}

export async function updateUser(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  patch: z.infer<typeof updateUserSchema>,
  meta: RequestMeta,
): Promise<repo.PublicUser> {
  await assertDepartmentExists(ctx, patch.departmentId);
  return withTx(ctx.pool, async (tx) => {
    if (!(await repo.lockUser(tx, id))) throw errors.notFound('User');
    const before = (await repo.getById(tx, id))!;
    assertDepartmentRule(
      before.roles,
      patch.departmentId === undefined ? before.departmentId : patch.departmentId,
    );
    await repo.updateProfile(tx, id, patch);
    await recordAudit(tx, {
      actorId: actor.id,
      action: 'user.updated',
      targetType: 'user',
      targetId: id,
      metadata: { fields: Object.keys(patch) },
      ...meta,
    });
    return (await repo.getById(tx, id))!;
  });
}

export async function setUserRoles(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  roles: Role[],
  meta: RequestMeta,
): Promise<repo.PublicUser> {
  return withTx(ctx.pool, async (tx) => {
    const activeAdmins = await repo.lockActiveAdminIds(tx);
    if (!(await repo.lockUser(tx, id))) throw errors.notFound('User');
    const before = (await repo.getById(tx, id))!;
    assertDepartmentRule(roles, before.departmentId);
    if (
      before.roles.includes('admin') &&
      !roles.includes('admin') &&
      before.isActive &&
      activeAdmins.length <= 1
    ) {
      throw errors.conflict(
        'LAST_ADMIN',
        'The last active administrator cannot lose the admin role',
      );
    }
    await repo.setRoles(tx, id, roles);
    await recordAudit(tx, {
      actorId: actor.id,
      action: 'user.roles_changed',
      targetType: 'user',
      targetId: id,
      metadata: { from: before.roles, to: roles },
      ...meta,
    });
    return (await repo.getById(tx, id))!;
  });
}

export async function setUserActive(
  ctx: AppContext,
  actor: AuthUser,
  id: string,
  active: boolean,
  meta: RequestMeta,
): Promise<repo.PublicUser> {
  return withTx(ctx.pool, async (tx) => {
    const activeAdmins = await repo.lockActiveAdminIds(tx);
    if (!(await repo.lockUser(tx, id))) throw errors.notFound('User');
    const before = (await repo.getById(tx, id))!;
    if (!active && before.roles.includes('admin') && before.isActive && activeAdmins.length <= 1) {
      throw errors.conflict('LAST_ADMIN', 'The last active administrator cannot be deactivated');
    }
    await repo.setActive(tx, id, active);
    if (!active) await revokeAllForUser(tx, id); // end every session immediately
    await recordAudit(tx, {
      actorId: actor.id,
      action: active ? 'user.activated' : 'user.deactivated',
      targetType: 'user',
      targetId: id,
      ...meta,
    });
    return (await repo.getById(tx, id))!;
  });
}
