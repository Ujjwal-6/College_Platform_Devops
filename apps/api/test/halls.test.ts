import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { as, buildOrg, buildTestApp, createHall, resetDb, type Org } from './helpers.js';

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const hallBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Main Auditorium',
  location: 'Block A',
  capacity: 500,
  facilities: ['Projector', ' AC ', 'projector'],
  ...overrides,
});

describe('hall administration', () => {
  it('lets an admin create a hall with normalised facilities, and audits it', async () => {
    const res = await as(t, org.admin).post('/api/halls', hallBody());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Main Auditorium',
      capacity: 500,
      isActive: true,
      facilities: ['projector', 'ac'],
      description: '',
    });
    const audit = await t.ctx.pool.query(
      "SELECT target_id FROM audit_log WHERE action = 'hall.created'",
    );
    expect(audit.rows).toEqual([{ target_id: res.body.data.id }]);
  });

  it('allows only admins to create or change halls (403), and requires sign-in (401)', async () => {
    const id = await createHall(t, org.admin);
    for (const who of [org.student, org.organizer, org.faculty, org.hod]) {
      expect((await as(t, who).post('/api/halls', hallBody())).status).toBe(403);
      expect((await as(t, who).patch(`/api/halls/${id}`, { capacity: 1 })).status).toBe(403);
    }
    expect((await request(t.app).get('/api/halls')).status).toBe(401);
    expect((await request(t.app).post('/api/halls').send(hallBody())).status).toBe(401);
  });

  it('lets everyone read active halls, but only admins see inactive ones', async () => {
    await createHall(t, org.admin, { name: 'Open Hall' });
    await createHall(t, org.admin, { name: 'Closed Hall', isActive: false });
    const student = await as(t, org.student).get('/api/halls?includeInactive=true');
    expect(student.body.data.map((h: { name: string }) => h.name)).toEqual(['Open Hall']);
    const admin = await as(t, org.admin).get('/api/halls?includeInactive=true');
    expect(admin.body.data.map((h: { name: string }) => h.name).sort()).toEqual([
      'Closed Hall',
      'Open Hall',
    ]);
    const closed = admin.body.data.find((h: { name: string }) => h.name === 'Closed Hall');
    expect((await as(t, org.student).get(`/api/halls/${closed.id}`)).status).toBe(404);
    expect((await as(t, org.admin).get(`/api/halls/${closed.id}`)).status).toBe(200);
  });

  it('keeps hall names unique regardless of case', async () => {
    await createHall(t, org.admin, { name: 'Seminar Room' });
    const dup = await as(t, org.admin).post('/api/halls', hallBody({ name: 'SEMINAR ROOM' }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('HALL_NAME_TAKEN');
  });

  it.each([
    ['zero capacity', { capacity: 0 }],
    ['negative capacity', { capacity: -5 }],
    ['fractional capacity', { capacity: 10.5 }],
    ['short name', { name: 'x' }],
    ['unknown field', { owner: 'me' }],
    ['too many facilities', { facilities: Array.from({ length: 31 }, (_, i) => `f${i}`) }],
    ['blank facility', { facilities: ['  '] }],
    ['capacity as text', { capacity: '100' }],
  ])('rejects %s with 400', async (_name, extra) => {
    const res = await as(t, org.admin).post('/api/halls', hallBody(extra));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('updates a hall, including deactivating it, and audits the change', async () => {
    const id = await createHall(t, org.admin, { name: 'Lab 1', capacity: 40 });
    const res = await as(t, org.admin).patch(`/api/halls/${id}`, {
      capacity: 60,
      isActive: false,
      facilities: ['Whiteboard'],
    });
    expect(res.body.data).toMatchObject({
      capacity: 60,
      isActive: false,
      facilities: ['whiteboard'],
      name: 'Lab 1',
    });
    const audit = await t.ctx.pool.query(
      "SELECT metadata FROM audit_log WHERE action = 'hall.updated'",
    );
    expect(audit.rows[0].metadata.fields.sort()).toEqual(['capacity', 'facilities', 'isActive']);
    expect((await as(t, org.admin).patch(`/api/halls/${id}`, {})).status).toBe(400);
    expect(
      (
        await as(t, org.admin).patch('/api/halls/00000000-0000-4000-8000-000000000000', {
          capacity: 5,
        })
      ).status,
    ).toBe(404);
    expect((await as(t, org.admin).patch('/api/halls/not-a-uuid', { capacity: 5 })).status).toBe(
      400,
    );
  });
});
