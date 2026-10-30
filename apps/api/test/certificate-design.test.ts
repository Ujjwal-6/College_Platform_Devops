import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCertificate, issueCertificates } from '../src/modules/certificates/handlers.js';
import { qrPng } from '../src/modules/attendance/qr.js';
import { as, bearer, buildOrg, buildTestApp, resetDb, type LoggedIn, type Org } from './helpers.js';
import { endedEvent, workerFor, type Presence } from './aftermath-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  t.mailer.sent.length = 0;
  rmSync(t.ctx.config.STORAGE_DIR, { recursive: true, force: true });
  await resetDb(t.ctx);
  org = await buildOrg(t);
  await t.ctx.pool.query('DELETE FROM certificate_template');
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const certs = (ev: string) =>
  q('SELECT * FROM certificates WHERE event_id = $1 ORDER BY holder_name', [ev]);
const audit = (a: string) => q('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [a]);
const emails = (n: string) =>
  q("SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'notification' = $1", [n]);
const files = () => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  try {
    walk(t.ctx.config.STORAGE_DIR);
  } catch {
    // nothing stored yet
  }
  return out;
};
const pdfText = (file: string) => {
  const raw = readFileSync(file).toString('latin1');
  const shown = [...raw.matchAll(/<([0-9a-f]{2,})>/gi)]
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
  return `${raw}\n${shown}`;
};
const issued = async (
  kinds: Presence[] = ['stayed', 'stayed'],
  over: Record<string, unknown> = {},
) => {
  const e = await endedEvent(t, org, kinds, over);
  await as(t, org.organizer).post(`/api/events/${e.ev}/certificates/issue`);
  await workerFor(t).drain();
  return { ...e, certs: await certs(e.ev) };
};
const revoke = (
  who: LoggedIn,
  id: string,
  body: object = { reason: 'Attendance was recorded by mistake' },
) => as(t, who).post(`/api/certificates/${id}/revoke`, body);
const reinstate = (who: LoggedIn, id: string) =>
  as(t, who).post(`/api/certificates/${id}/reinstate`);
const verify = (code: string) => request(t.app).get(`/api/certificates/verify/${code}`);

describe('withdrawing a certificate', () => {
  it('lets the organizer or an admin withdraw it with a reason, and records it', async () => {
    const { certs: made, people } = await issued();
    const target = made.find((c) => c.user_id === people[0]!.user.id)!;
    const res = await revoke(org.organizer, target.id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: target.id,
      revokeReason: 'Attendance was recorded by mistake',
    });
    expect(res.body.data.revokedAt).toBeTruthy();
    expect(await audit('certificate.revoked')).toHaveLength(1);
    expect((await audit('certificate.revoked'))[0].metadata).toMatchObject({
      reason: 'Attendance was recorded by mistake',
      userId: people[0]!.user.id,
    });

    const other = made.find((c) => c.id !== target.id)!;
    expect((await revoke(org.admin, other.id, { reason: 'Duplicate registration' })).status).toBe(
      200,
    );
  });

  it('is for the organizer of that event and admins only', async () => {
    const { certs: made, people } = await issued();
    for (const who of [org.faculty, org.hod, org.student, org.otherOrganizer, people[0]!]) {
      expect([403, 404]).toContain((await revoke(who, made[0]!.id)).status);
    }
    expect(
      (await request(t.app).post(`/api/certificates/${made[0]!.id}/revoke`).send({ reason: 'abc' }))
        .status,
    ).toBe(401);
    expect(
      (await q('SELECT revoked_at FROM certificates WHERE id = $1', [made[0]!.id]))[0].revoked_at,
    ).toBeNull();
  });

  it('needs a real reason and a known certificate (400, 404)', async () => {
    const { certs: made } = await issued();
    for (const bad of [
      {},
      { reason: '' },
      { reason: 'ab' },
      { reason: 'x'.repeat(301) },
      { reason: 'fine reason', extra: 1 },
    ]) {
      expect((await revoke(org.organizer, made[0]!.id, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await revoke(org.organizer, '11111111-1111-4111-8111-111111111111')).status).toBe(404);
    expect((await revoke(org.organizer, 'not-a-uuid')).status).toBe(400);
  });

  it('cannot be done twice, by the service or by two admins at once', async () => {
    const { certs: made } = await issued();
    const results = await Promise.all(
      [org.admin, org.admin2, org.organizer].map((who) => revoke(who, made[0]!.id)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter((r) => r.status !== 200).every((r) => r.body.error.code === 'ALREADY_REVOKED'),
    ).toBe(true);
    expect(await audit('certificate.revoked')).toHaveLength(1);
  });

  it('makes the code say "withdrawn", shows nothing else, and stops the download', async () => {
    const { certs: made, people } = await issued();
    const target = made.find((c) => c.user_id === people[0]!.user.id)!;
    await revoke(org.organizer, target.id);
    const res = await verify(target.code);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ valid: false, revoked: true, code: target.code });
    expect(JSON.stringify(res.body)).not.toContain(target.holder_name);

    const dl = await as(t, people[0]!).get(`/api/certificates/${target.id}/download`);
    expect(dl.status).toBe(409);
    expect(dl.body.error.code).toBe('CERTIFICATE_REVOKED');
    const mine = await as(t, people[0]!).get('/api/certificates');
    expect(mine.body.data[0].revokedAt).toBeTruthy();
    expect(JSON.stringify(mine.body)).not.toContain('recorded by mistake'); // the holder is not shown the reason
    const other = made.find((c) => c.id !== target.id)!;
    expect((await verify(other.code)).body.data.valid).toBe(true); // others are untouched
  });

  it('is shown to the organizer with the reason and counted in the summary', async () => {
    const { ev, certs: made } = await issued();
    await revoke(org.organizer, made[0]!.id, { reason: 'Wrong person' });
    const res = await as(t, org.organizer).get(`/api/events/${ev}/certificates`);
    expect(res.body.summary).toMatchObject({ issued: 2, revoked: 1 });
    expect(res.body.data.find((c: { id: string }) => c.id === made[0]!.id)).toMatchObject({
      revokeReason: 'Wrong person',
    });
  });

  it('is not undone by issuing again, and a re-run never gives the person a new certificate', async () => {
    const { ev, certs: made } = await issued();
    await revoke(org.organizer, made[0]!.id);
    await issueCertificates(t.ctx, { eventId: ev });
    await as(t, org.organizer).post(`/api/events/${ev}/certificates/issue`);
    await workerFor(t).drain();
    expect(await certs(ev)).toHaveLength(2);
    expect(
      (await q('SELECT revoked_at FROM certificates WHERE id = $1', [made[0]!.id]))[0].revoked_at,
    ).not.toBeNull();
  });

  it('can be reinstated by the same people, only if it was withdrawn', async () => {
    const { certs: made, people } = await issued();
    const id = made[0]!.id as string;
    expect((await reinstate(org.organizer, id)).body.error.code).toBe('NOT_REVOKED');
    await revoke(org.organizer, id);
    for (const who of [org.faculty, org.student, org.otherOrganizer, people[0]!]) {
      expect([403, 404]).toContain((await reinstate(who, id)).status);
    }
    const res = await reinstate(org.admin, id);
    expect(res.status).toBe(200);
    expect(res.body.data.revokedAt).toBeNull();
    expect((await verify(made[0]!.code)).body.data.valid).toBe(true);
    expect(await audit('certificate.reinstated')).toHaveLength(1);
    expect((await reinstate(org.organizer, id)).body.error.code).toBe('NOT_REVOKED');
  });

  it('is enforced by the database: a withdrawal always has who, when and a reason', async () => {
    const { certs: made } = await issued();
    const id = made[0]!.id;
    await expect(
      q('UPDATE certificates SET revoked_at = now() WHERE id = $1', [id]),
    ).rejects.toMatchObject({ constraint: 'certificates_revoked_check' });
    await expect(
      q(
        "UPDATE certificates SET revoked_at = now(), revoked_by = $2, revoke_reason = 'x' WHERE id = $1",
        [id, org.admin.user.id],
      ),
    ).rejects.toMatchObject({ constraint: 'certificates_revoked_check' });
  });
});

describe('the design of certificates (admin)', () => {
  const putText = (who: LoggedIn, body: object) =>
    as(t, who).put('/api/certificate-template', body);
  const putImage = (who: LoggedIn, kind: string, data: Buffer | string, type = 'image/png') =>
    request(t.app)
      .put(`/api/certificate-template/${kind}`)
      .set(bearer(who.accessToken))
      .set('Content-Type', type)
      .send(data);
  const png = () => qrPng('a stand-in for a logo');

  it('starts empty and is admin only', async () => {
    const res = await as(t, org.admin).get('/api/certificate-template');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      organizationName: null,
      signatoryName: null,
      signatoryTitle: null,
      hasLogo: false,
      hasSignature: false,
      updatedAt: null,
    });
    for (const who of [org.organizer, org.faculty, org.hod, org.student]) {
      expect((await as(t, who).get('/api/certificate-template')).status).toBe(403);
      expect((await putText(who, { organizationName: 'X' })).status).toBe(403);
      expect((await putImage(who, 'logo', await png())).status).toBe(403);
      expect((await as(t, who).delete('/api/certificate-template/logo')).status).toBe(403);
    }
    expect((await request(t.app).get('/api/certificate-template')).status).toBe(401);
  });

  it('saves the names, one field at a time, clears them, and audits it', async () => {
    const a = await putText(org.admin, {
      organizationName: 'Sunrise College',
      signatoryName: 'Dr A. Rao',
    });
    expect(a.body.data).toMatchObject({
      organizationName: 'Sunrise College',
      signatoryName: 'Dr A. Rao',
      signatoryTitle: null,
    });
    const b = await putText(org.admin, { signatoryTitle: 'Principal' });
    expect(b.body.data).toMatchObject({
      organizationName: 'Sunrise College',
      signatoryName: 'Dr A. Rao',
      signatoryTitle: 'Principal',
    });
    const c = await putText(org.admin, { signatoryName: '' });
    expect(c.body.data.signatoryName).toBeNull();
    expect(await audit('certificate.template_changed')).toHaveLength(3);
    expect((await audit('certificate.template_changed'))[0].metadata).toEqual({
      fields: ['organizationName', 'signatoryName'],
    });
  });

  it('rejects empty, unknown or too long input (400)', async () => {
    for (const bad of [
      {},
      { other: 1 },
      { organizationName: 'x'.repeat(121) },
      { organizationName: 5 },
      { signatoryName: 'ok', extra: true },
    ]) {
      expect((await putText(org.admin, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('stores a PNG or JPEG logo and signature, and replaces them, removing the old file', async () => {
    const first = await putImage(org.admin, 'logo', await png());
    expect(first.status).toBe(200);
    expect(first.body.data.hasLogo).toBe(true);
    const oldKey = (await q('SELECT logo_key FROM certificate_template'))[0].logo_key as string;
    expect(files()).toHaveLength(1);

    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
    expect(
      (await putImage(org.admin, 'signature', jpeg, 'image/jpeg')).body.data.hasSignature,
    ).toBe(true);
    expect(files()).toHaveLength(2);

    expect((await putImage(org.admin, 'logo', await qrPng('a different logo'))).status).toBe(200);
    expect((await q('SELECT logo_key FROM certificate_template'))[0].logo_key).not.toBe(oldKey);
    expect(files()).toHaveLength(2); // the replaced file is gone
  });

  it('refuses anything that is not really a PNG or JPEG, or is too large', async () => {
    const fake = await putImage(
      org.admin,
      'logo',
      Buffer.from('<svg onload=alert(1)></svg>'),
      'image/png',
    );
    expect(fake.status).toBe(422);
    expect(fake.body.error.code).toBe('INVALID_FILE');
    expect(
      (await putImage(org.admin, 'logo', Buffer.from('%PDF-1.3 not an image'), 'image/png')).status,
    ).toBe(422);
    expect((await putImage(org.admin, 'logo', Buffer.alloc(0), 'image/png')).status).toBe(422); // an empty file is not an image
    const wrongType = await putImage(org.admin, 'logo', await png(), 'application/octet-stream');
    expect(wrongType.status).toBe(415);
    const big = await putImage(
      org.admin,
      'logo',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(1_100_000),
      ]),
      'image/png',
    );
    expect(big.status).toBe(413);
    expect((await putImage(org.admin, 'banner', await png())).status).toBe(400);
    expect(files()).toHaveLength(0);
    expect((await as(t, org.admin).get('/api/certificate-template')).body.data.hasLogo).toBe(false);
  });

  it('removes an image and its file', async () => {
    await putImage(org.admin, 'signature', await png());
    expect(files()).toHaveLength(1);
    const res = await as(t, org.admin).delete('/api/certificate-template/signature');
    expect(res.status).toBe(200);
    expect(res.body.data.hasSignature).toBe(false);
    expect(files()).toHaveLength(0);
    expect((await as(t, org.admin).delete('/api/certificate-template/signature')).status).toBe(200); // nothing left: harmless
  });
});

describe('certificates with the college’s design', () => {
  it('always shows the organising department, and nothing else until a design is supplied', async () => {
    const { certs: made } = await issued(['stayed']);
    await generateCertificate(
      t.ctx,
      { certificateId: made[0]!.id, regenerate: true },
      { compress: false },
    );
    const text = pdfText(files().find((f) => f.endsWith('.pdf'))!);
    expect(text).toContain('Organised by the Department of Computer Science');
    expect(text).not.toContain('Principal');
    // the QR code only. A PNG with transparency is two objects in the file: the picture and its mask
    expect((text.match(/\/Subtype \/Image/g) ?? []).length).toBe(2);
  });

  it('puts the logo, organisation, signature and signatory on a certificate drawn after they were supplied', async () => {
    const png = await qrPng('logo or signature stand-in');
    await as(t, org.admin).put('/api/certificate-template', {
      organizationName: 'Sunrise College of Engineering',
      signatoryName: 'Dr A. Rao',
      signatoryTitle: 'Principal',
    });
    await request(t.app)
      .put('/api/certificate-template/logo')
      .set(bearer(org.admin.accessToken))
      .set('Content-Type', 'image/png')
      .send(png);
    await request(t.app)
      .put('/api/certificate-template/signature')
      .set(bearer(org.admin.accessToken))
      .set('Content-Type', 'image/png')
      .send(png);

    const { certs: made } = await issued(['stayed']);
    await generateCertificate(
      t.ctx,
      { certificateId: made[0]!.id, regenerate: true },
      { compress: false },
    );
    const text = pdfText(files().find((f) => f.endsWith('.pdf'))!);
    for (const expected of [
      'Sunrise College of Engineering',
      'Dr A. Rao',
      'Principal',
      'Certificate of Participation',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect((text.match(/\/Subtype \/Image/g) ?? []).length).toBe(6); // QR code, logo and signature, two objects each
  });

  it('still makes certificates when a stored image has gone missing', async () => {
    await request(t.app)
      .put('/api/certificate-template/logo')
      .set(bearer(org.admin.accessToken))
      .set('Content-Type', 'image/png')
      .send(await qrPng('logo'));
    for (const f of files()) rmSync(f);
    const { certs: made } = await issued(['stayed']);
    expect(made[0]!.status).toBe('ready');
  });
});

describe('redrawing every certificate of an event (admin)', () => {
  it('draws them all again with the current design and name, keeping codes, without emailing anyone again', async () => {
    const { ev, certs: before, people } = await issued(['stayed', 'stayed', 'stayed']);
    const pdfsBefore = files().length;
    await as(t, org.admin).put('/api/certificate-template', {
      organizationName: 'Sunrise College',
    });
    await q('UPDATE users SET name = $2 WHERE id = $1', [people[0]!.user.id, 'Corrected Name']);

    const res = await as(t, org.admin).post(`/api/events/${ev}/certificates/redraw`);
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ queued: 3 });
    await workerFor(t).drain();

    const after = await certs(ev);
    expect(after.map((c) => c.code).sort()).toEqual(before.map((c) => c.code).sort());
    expect(
      after.every((c) => c.storage_key !== before.find((b) => b.id === c.id)!.storage_key),
    ).toBe(true);
    expect(files()).toHaveLength(pdfsBefore); // the old files are gone
    expect(after.find((c) => c.user_id === people[0]!.user.id)!.holder_name).toBe('Corrected Name');
    expect(await emails('certificate.ready')).toHaveLength(3);
    expect(await audit('certificate.regenerated')).toHaveLength(1);
  });

  it('is for admins only', async () => {
    const { ev } = await issued(['stayed']);
    for (const who of [org.organizer, org.faculty, org.hod, org.student]) {
      expect((await as(t, who).post(`/api/events/${ev}/certificates/redraw`)).status).toBe(403);
    }
    expect(
      (await request(t.app).post(`/api/events/${ev}/certificates/redraw`).send({})).status,
    ).toBe(401);
    expect(
      (
        await as(t, org.admin).post(
          '/api/events/11111111-1111-4111-8111-111111111111/certificates/redraw',
        )
      ).status,
    ).toBe(404);
    expect(
      (await as(t, org.admin).post(`/api/events/${ev}/certificates/redraw`, { x: 1 })).status,
    ).toBe(400);
  });
});
