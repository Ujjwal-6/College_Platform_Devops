import { describe, expect, it } from 'vitest';
import { canCompleteWorkflow, checkApprover, NEXT_LEVEL } from '../src/modules/approvals/policy.js';
import { assertDepartmentScope } from '../src/modules/auth/middleware.js';
import type { AuthUser, Role } from '../src/modules/auth/types.js';
import {
  canCreateEvents,
  canView,
  canViewWorkflow,
  isEligibleForRegistration,
  MATERIAL_FIELDS,
  TRANSITIONS,
} from '../src/modules/events/lifecycle.js';
import { validateShape } from '../src/modules/events/schemas.js';
import { EVENT_STATUSES, type EventRecord, type EventStatus } from '../src/modules/events/types.js';
import { renderNotification } from '../src/modules/notifications/templates.js';

const DEPT = 'dept-cse';
const OTHER = 'dept-ece';
const user = (id: string, roles: Role[], departmentId: string | null = DEPT): AuthUser => ({
  id,
  email: `${id}@x.test`,
  name: id,
  roles,
  departmentId,
});
const event = (over: Partial<EventRecord> = {}) =>
  ({
    id: 'e1',
    organizerId: 'owner',
    departmentId: DEPT,
    status: 'pending_approval',
    approvalLevel: 'faculty',
    startAt: new Date(Date.now() + 86_400_000),
    registrationDeadline: null,
    ...over,
  }) as EventRecord;

describe('assertDepartmentScope (characterization of the shared helper)', () => {
  const pass = (u: AuthUser, dept: string | null) =>
    expect(() => assertDepartmentScope(u, dept)).not.toThrow();
  const fail = (u: AuthUser, dept: string | null) =>
    expect(() => assertDepartmentScope(u, dept)).toThrow(/permission/);

  it('lets admins through for any department, including none', () => {
    pass(user('a', ['admin'], null), DEPT);
    pass(user('a', ['admin'], null), OTHER);
    pass(user('a', ['admin'], null), null);
  });
  it('lets HODs and faculty through only for their own department', () => {
    pass(user('h', ['hod']), DEPT);
    pass(user('f', ['faculty']), DEPT);
    fail(user('h', ['hod']), OTHER);
    fail(user('f', ['faculty']), OTHER);
  });
  it('refuses staff without a department, a null target, and roles that are not department staff', () => {
    fail(user('h', ['hod'], null), DEPT);
    fail(user('h', ['hod']), null);
    fail(user('o', ['organizer']), DEPT);
    fail(user('s', ['student']), DEPT);
  });
  it('does NOT know which approval step is being performed — so it must never be used alone for approvals', () => {
    const faculty = user('f', ['faculty']);
    pass(faculty, DEPT); // a faculty member "passes" the scope check for any step in their department...
    // ...which is why approvals use checkApprover (role of the level AND department AND not-owner AND not-repeat):
    expect(checkApprover(faculty, event(), 'hod', new Set())).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
    expect(checkApprover(faculty, event(), 'admin', new Set())).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
  });
});

describe('checkApprover', () => {
  const none = new Set<string>();
  it('accepts the right role in the right department', () => {
    expect(checkApprover(user('f', ['faculty']), event(), 'faculty', none)).toEqual({ ok: true });
    expect(checkApprover(user('h', ['hod']), event(), 'hod', none)).toEqual({ ok: true });
    expect(checkApprover(user('a', ['admin'], null), event(), 'admin', none)).toEqual({ ok: true });
  });
  it('requires the role of the level: neither seniority nor department match substitutes', () => {
    expect(checkApprover(user('h', ['hod']), event(), 'faculty', none)).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
    expect(checkApprover(user('a', ['admin'], null), event(), 'faculty', none)).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
    expect(checkApprover(user('a', ['admin'], null), event(), 'hod', none)).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
    expect(checkApprover(user('f', ['faculty']), event(), 'admin', none)).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
    expect(checkApprover(user('o', ['organizer']), event(), 'faculty', none)).toEqual({
      ok: false,
      reason: 'wrong_role',
    });
  });
  it("limits faculty and HOD to the event's department but not admins", () => {
    expect(checkApprover(user('f', ['faculty'], OTHER), event(), 'faculty', none)).toEqual({
      ok: false,
      reason: 'wrong_department',
    });
    expect(checkApprover(user('h', ['hod'], null), event(), 'hod', none)).toEqual({
      ok: false,
      reason: 'wrong_department',
    });
    expect(checkApprover(user('a', ['admin'], OTHER), event(), 'admin', none)).toEqual({
      ok: true,
    });
  });
  it('refuses the organizer even when they hold the role', () => {
    expect(checkApprover(user('owner', ['faculty']), event(), 'faculty', none)).toEqual({
      ok: false,
      reason: 'own_event',
    });
    expect(checkApprover(user('owner', ['admin'], null), event(), 'admin', none)).toEqual({
      ok: false,
      reason: 'own_event',
    });
  });
  it('refuses someone who already decided a level in this round', () => {
    expect(
      checkApprover(user('both', ['faculty', 'hod']), event(), 'hod', new Set(['both'])),
    ).toEqual({ ok: false, reason: 'already_decided' });
  });
  it('lets a user with several roles act at the level their roles cover', () => {
    expect(checkApprover(user('both', ['faculty', 'hod']), event(), 'hod', none)).toEqual({
      ok: true,
    });
  });
  it('knows the fixed order', () => {
    expect(NEXT_LEVEL).toEqual({ faculty: 'hod', hod: 'admin', admin: null });
  });
});

describe('canCompleteWorkflow', () => {
  it('needs a different person for each level', () => {
    expect(canCompleteWorkflow(['f'], ['h'], ['a'])).toBe(true);
    expect(canCompleteWorkflow(['x'], ['x'], ['a'])).toBe(false);
    expect(canCompleteWorkflow(['x'], ['h'], ['x'])).toBe(false);
    expect(canCompleteWorkflow(['f'], ['h'], [])).toBe(false);
    expect(canCompleteWorkflow(['x', 'f'], ['x'], ['a'])).toBe(true); // f covers faculty, x the HOD level
    expect(canCompleteWorkflow(['x'], ['x', 'h'], ['a'])).toBe(true);
    expect(canCompleteWorkflow(['x'], ['x'], ['x'])).toBe(false);
    expect(canCompleteWorkflow(['x', 'y'], ['x', 'y'], ['x', 'y'])).toBe(false); // two people, three levels
    expect(canCompleteWorkflow(['x', 'y'], ['x', 'y'], ['x', 'y', 'z'])).toBe(true);
  });
});

describe('lifecycle table', () => {
  const targets = Object.values(TRANSITIONS).map((t) => t.to);
  it('only uses real statuses and never leaves a terminal state', () => {
    for (const t of Object.values(TRANSITIONS)) {
      expect(EVENT_STATUSES).toContain(t.to);
      for (const from of t.from as readonly string[]) {
        expect(EVENT_STATUSES as readonly string[]).toContain(from);
        expect(['closed', 'cancelled']).not.toContain(from); // terminal states have no way out
      }
    }
    expect(targets.filter((s) => s === 'approved')).toHaveLength(1); // only unpublish; the final approval is handled by approvals
  });
  it('has no way into published except through approved, and no way to approved except approvals/unpublish', () => {
    expect(TRANSITIONS.publish.from).toEqual(['approved']);
    expect(TRANSITIONS.submit.from).toEqual(['draft']);
    expect(
      Object.entries(TRANSITIONS)
        .filter(([, t]) => t.to === 'pending_approval')
        .map(([k]) => k),
    ).toEqual(['submit']);
  });
  it('cannot cancel or revise what is already finished', () => {
    for (const s of ['closed', 'cancelled'] as EventStatus[]) {
      expect(TRANSITIONS.cancel.from as readonly string[]).not.toContain(s);
      expect(TRANSITIONS.revise.from as readonly string[]).not.toContain(s);
    }
  });
  it('lists the material fields', () => {
    expect([...MATERIAL_FIELDS].sort()).toEqual([
      'capacity',
      'category',
      'departmentId',
      'endAt',
      'expectedAttendance',
      'registrationMode',
      'startAt',
      'teamSizeMax',
      'teamSizeMin',
    ]);
  });
});

describe('visibility', () => {
  const draft = event({ status: 'draft', approvalLevel: null });
  it('draft: owner and admin only', () => {
    expect(canView(user('owner', ['organizer']), draft)).toBe(true);
    expect(canView(user('a', ['admin'], null), draft)).toBe(true);
    expect(canView(user('f', ['faculty']), draft)).toBe(false);
    expect(canView(user('h', ['hod']), draft)).toBe(false);
  });
  it('in-flight and finished-unpublished events: owner, admin, department staff', () => {
    for (const status of ['pending_approval', 'approved', 'cancelled'] as const) {
      const e = event({ status, approvalLevel: status === 'pending_approval' ? 'faculty' : null });
      expect(canView(user('f', ['faculty']), e)).toBe(true);
      expect(canView(user('f', ['faculty'], OTHER), e)).toBe(false);
      expect(canView(user('s', ['student']), e)).toBe(false);
      expect(canView(user('o', ['organizer']), e)).toBe(false);
    }
  });
  it('published and closed are visible to everyone, but the workflow is not', () => {
    for (const status of ['published', 'closed'] as const) {
      const e = event({ status, approvalLevel: null });
      expect(canView(user('s', ['student'], OTHER), e)).toBe(true);
      expect(canViewWorkflow(user('s', ['student'], OTHER), e)).toBe(false);
      expect(canViewWorkflow(user('f', ['faculty']), e)).toBe(true);
    }
  });
  it('only student heads, faculty, HODs and admins can create events', () => {
    expect(canCreateEvents(user('s', ['student']))).toBe(false);
    for (const r of ['organizer', 'faculty', 'hod', 'admin'] as const)
      expect(canCreateEvents(user('x', [r]))).toBe(true);
  });
});

describe('registration eligibility contract', () => {
  const base = { startAt: new Date('2031-01-10T10:00:00Z'), registrationDeadline: null };
  it('requires published status and a deadline (default: the start time) in the future', () => {
    const before = new Date('2031-01-09T00:00:00Z');
    expect(isEligibleForRegistration({ ...base, status: 'published' }, before)).toBe(true);
    for (const status of [
      'draft',
      'pending_approval',
      'approved',
      'closed',
      'cancelled',
    ] as const) {
      expect(isEligibleForRegistration({ ...base, status }, before)).toBe(false);
    }
    expect(
      isEligibleForRegistration({ ...base, status: 'published' }, new Date('2031-01-10T10:00:00Z')),
    ).toBe(false);
    const withDeadline = {
      ...base,
      status: 'published' as const,
      registrationDeadline: new Date('2031-01-05T00:00:00Z'),
    };
    expect(isEligibleForRegistration(withDeadline, new Date('2031-01-04T00:00:00Z'))).toBe(true);
    expect(isEligibleForRegistration(withDeadline, new Date('2031-01-06T00:00:00Z'))).toBe(false);
  });
});

describe('validateShape', () => {
  const ok = {
    startAt: new Date('2031-01-01T10:00:00Z'),
    endAt: new Date('2031-01-01T12:00:00Z'),
    registrationMode: 'individual' as const,
    teamSizeMin: null,
    teamSizeMax: null,
    registrationDeadline: null,
  };
  it('accepts valid shapes', () => {
    expect(validateShape(ok)).toEqual([]);
    expect(
      validateShape({
        ...ok,
        registrationMode: 'team',
        teamSizeMin: 2,
        teamSizeMax: 2,
        registrationDeadline: ok.startAt,
      }),
    ).toEqual([]);
  });
  it('reports each problem with its field', () => {
    expect(validateShape({ ...ok, endAt: ok.startAt }).map((i) => i.path)).toEqual(['endAt']);
    expect(validateShape({ ...ok, teamSizeMin: 2, teamSizeMax: 3 }).map((i) => i.path)).toEqual([
      'teamSizeMin',
    ]);
    expect(validateShape({ ...ok, registrationMode: 'team' }).map((i) => i.path)).toEqual([
      'teamSizeMin',
    ]);
    expect(
      validateShape({ ...ok, registrationMode: 'team', teamSizeMin: 5, teamSizeMax: 3 }).map(
        (i) => i.path,
      ),
    ).toEqual(['teamSizeMax']);
    expect(
      validateShape({ ...ok, registrationDeadline: new Date('2031-01-02T00:00:00Z') }).map(
        (i) => i.path,
      ),
    ).toEqual(['registrationDeadline']);
  });
});

describe('event email templates', () => {
  it('keeps user-supplied text out of the subject line structure', () => {
    const mail = renderNotification('event.approval_requested', {
      name: 'Dr. A',
      eventTitle: 'Hack Night\r\nBcc: attacker@evil.test',
      level: 'faculty',
      organizerName: 'Sam',
      url: 'http://x/events/1',
    });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.subject).toBe('Approval needed: Hack Night Bcc: attacker@evil.test');
  });
  it('explains each decision outcome', () => {
    const base = {
      name: 'Sam',
      eventTitle: 'Fest',
      level: 'hod',
      approverName: 'Dr. B',
      comment: '',
      url: 'http://x',
    };
    expect(renderNotification('event.decision', { ...base, decision: 'approved' }).text).toContain(
      'moves to the next level',
    );
    expect(
      renderNotification('event.decision', { ...base, decision: 'fully_approved' }).text,
    ).toContain('fully approved');
    const rejected = renderNotification('event.decision', {
      ...base,
      decision: 'rejected',
      comment: 'Too long',
    });
    expect(rejected.subject).toMatch(/^Event rejected/);
    expect(rejected.text).toContain('Comment: Too long');
  });
});
