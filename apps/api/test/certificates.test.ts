import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCertificate, issueCertificates } from '../src/modules/certificates/handlers.js';
import { PermanentJobError } from '../src/platform/jobs/worker.js';
import { as, buildOrg, buildTestApp, resetDb, type Org } from './helpers.js';
import { endedEvent, workerFor, type Presence } from './aftermath-helpers.js';
import { createPublishedEvent, register, students } from './registration-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  t.mailer.sent.length = 0;
  rmSync(t.ctx.config.STORAGE_DIR, { recursive: true, force: true });
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const certs = (ev: string) =>
  q('SELECT * FROM certificates WHERE event_id = $1 ORDER BY holder_name', [ev]);
const jobs = (type: string) => q('SELECT * FROM jobs WHERE type = $1', [type]);
const audit = (a: string) => q('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [a]);
const emails = (n: string) =>
  q("SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'notification' = $1", [n]);
const pdfs = () => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.pdf')) out.push(p);
    }
  };
  try {
    walk(t.ctx.config.STORAGE_DIR);
  } catch {
    // nothing stored yet
  }
  return out;
};
/** The text drawn on the page; pdfkit writes it as hex strings. */
const pdfText = (file: string) => {
  const raw = readFileSync(file).toString('latin1');
  const shown = [...raw.matchAll(/<([0-9a-f]{2,})>/gi)]
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
  return `${raw}\n${shown}`;
};
const nameOf = async (userId: string, name: string) =>
  q('UPDATE users SET name = $2 WHERE id = $1', [userId, name]);
const CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const closeEvent = (ev: string) => as(t, org.organizer).post(`/api/events/${ev}/close`);
/** Certificates are only issued when the organizer presses Issue (the product owner's decision). */
const issue = (ev: string) => as(t, org.organizer).post(`/api/events/${ev}/certificates/issue`);

describe('issuing certificates (AC-8.1, AC-8.2)', () => {
  it('gives one to everyone who stayed to the end when the organizer issues them, and to nobody else', async () => {
    const kinds: Presence[] = ['stayed', 'stayed', 'left_early', 'inside', 'absent', 'cancelled'];
    const { ev, people } = await endedEvent(t, org, kinds);
    expect((await issue(ev)).status).toBe(202);
    expect(await jobs('certificate.issue_event')).toHaveLength(1);
    expect(await certs(ev)).toHaveLength(0); // the request does not make them; the worker does

    await workerFor(t).drain();
    const made = await certs(ev);
    expect(made.map((c) => c.user_id).sort()).toEqual(
      [people[0]!.user.id, people[1]!.user.id].sort(),
    );
    for (const p of [people[2]!, people[3]!, people[4]!, people[5]!]) {
      expect(made.some((c) => c.user_id === p.user.id)).toBe(false);
    }
    expect(made.every((c) => c.status === 'ready' && CODE.test(c.code))).toBe(true);
    expect(pdfs()).toHaveLength(2);
    expect(await audit('certificate.issued')).toHaveLength(2);
  });

  it('does not issue anything just because the event was closed', async () => {
    const { ev } = await endedEvent(t, org, ['stayed', 'stayed']);
    expect((await closeEvent(ev)).status).toBe(200);
    await workerFor(t).drain();
    expect(await jobs('certificate.issue_event')).toHaveLength(0);
    expect(await certs(ev)).toHaveLength(0);
    await issue(ev);
    await workerFor(t).drain();
    expect(await certs(ev)).toHaveLength(2);
  });

  it('is not blocked by missing feedback', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    await issue(ev);
    await workerFor(t).drain();
    expect(await certs(ev)).toHaveLength(1);
    expect(await q('SELECT 1 FROM feedback')).toHaveLength(0);
  });

  it('counts being checked in as enough when the organizer does not require check-out', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed', 'left_early', 'inside', 'absent']);
    await q(
      'INSERT INTO event_attendance_settings (event_id, require_check_out, updated_by) VALUES ($1, false, $2)',
      [ev, org.organizer.user.id],
    );
    await issue(ev);
    await workerFor(t).drain();
    expect((await certs(ev)).map((c) => c.user_id).sort()).toEqual(
      [people[0]!.user.id, people[1]!.user.id, people[2]!.user.id].sort(),
    );
  });

  it('never makes a second certificate when the job is run again or retried', async () => {
    const { ev } = await endedEvent(t, org, ['stayed', 'stayed', 'stayed']);
    await issue(ev);
    const w = workerFor(t);
    await w.drain();
    const first = await certs(ev);
    await issueCertificates(t.ctx, { eventId: ev });
    await issueCertificates(t.ctx, { eventId: ev });
    await w.drain();
    const after = await certs(ev);
    expect(after).toHaveLength(3);
    expect(after.map((c) => c.code).sort()).toEqual(first.map((c) => c.code).sort());
    expect(pdfs()).toHaveLength(3);
    expect(await emails('certificate.ready')).toHaveLength(3);
    for (const c of first) {
      await generateCertificate(t.ctx, { certificateId: c.id }); // already done: nothing changes
    }
    expect(pdfs()).toHaveLength(3);
    expect(await audit('certificate.issued')).toHaveLength(3);
  });

  it('is protected by the database too: one certificate per person per event, codes unique', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    await issue(ev);
    await workerFor(t).drain();
    const [c] = await certs(ev);
    await expect(
      q(
        "INSERT INTO certificates (event_id, user_id, code, holder_name) VALUES ($1, $2, 'AAAA-AAAA-AAAA-AAAA', 'x')",
        [ev, people[0]!.user.id],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'certificates_event_user_key' });
    const other = await createPublishedEvent(t, org);
    await expect(
      q('INSERT INTO certificates (event_id, user_id, code, holder_name) VALUES ($1, $2, $3, $4)', [
        other,
        people[0]!.user.id,
        c.code,
        'x',
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'certificates_code_key' });
    await expect(
      q("UPDATE certificates SET status = 'ready', storage_key = NULL WHERE id = $1", [c.id]),
    ).rejects.toMatchObject({ constraint: 'certificates_ready_check' });
  });

  it('ends with one certificate each when several workers issue at the same moment', async () => {
    const { ev } = await endedEvent(t, org, ['stayed', 'stayed', 'stayed', 'stayed']);
    await Promise.all(Array.from({ length: 6 }, () => issueCertificates(t.ctx, { eventId: ev })));
    expect(await certs(ev)).toHaveLength(4);
    expect(await jobs('certificate.generate')).toHaveLength(4);
  });

  it('copes with a large event (60 people)', async () => {
    const { ev } = await endedEvent(t, org, Array(60).fill('stayed') as Presence[]);
    await issue(ev);
    await workerFor(t).drain();
    const made = await certs(ev);
    expect(made).toHaveLength(60);
    expect(made.every((c) => c.status === 'ready')).toBe(true);
    expect(new Set(made.map((c) => c.code)).size).toBe(60);
    expect(pdfs()).toHaveLength(60);
  });

  it('makes nothing for an event that is not over, cancelled, or unknown', async () => {
    const running = await createPublishedEvent(t, org);
    const [p] = await students(t, 1);
    await register(t, p!, running);
    await issueCertificates(t.ctx, { eventId: running });
    expect(await certs(running)).toHaveLength(0);

    const { ev } = await endedEvent(t, org, ['stayed']);
    await q("UPDATE events SET status = 'cancelled' WHERE id = $1", [ev]);
    await issueCertificates(t.ctx, { eventId: ev });
    expect(await certs(ev)).toHaveLength(0);
    await issueCertificates(t.ctx, { eventId: '11111111-1111-4111-8111-111111111111' });
  });

  it('fails a malformed job for good instead of retrying it', async () => {
    await expect(issueCertificates(t.ctx, { eventId: 'nope' })).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    await expect(generateCertificate(t.ctx, {})).rejects.toBeInstanceOf(PermanentJobError);
    await expect(
      generateCertificate(t.ctx, { certificateId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe('issuing on request', () => {
  it('lets the organizer or an admin issue after the event, picking up people who became eligible later', async () => {
    const { ev, regs, people } = await endedEvent(t, org, ['stayed', 'inside']);
    const first = await as(t, org.organizer).post(`/api/events/${ev}/certificates/issue`);
    expect(first.status).toBe(202);
    expect(first.body.data).toMatchObject({ queued: true, eligible: 1, issued: 0 });
    await workerFor(t).drain();
    expect(await certs(ev)).toHaveLength(1);

    // the person still inside checks out just before the end
    await q(
      "UPDATE attendance SET checked_out_at = now() - interval '12 minutes', checked_out_by = $2, check_out_method = 'qr' WHERE registration_id = $1",
      [regs[1], org.organizer.user.id],
    );
    const second = await as(t, org.admin).post(`/api/events/${ev}/certificates/issue`);
    expect(second.body.data).toMatchObject({ eligible: 2, issued: 1 });
    await workerFor(t).drain();
    expect((await certs(ev)).map((c) => c.user_id).sort()).toEqual(
      people.map((p) => p.user.id).sort(),
    );
    expect(await audit('certificate.issue_requested')).toHaveLength(2);
  });

  it('is for the organizer and admins only, and only once the event is over', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    for (const who of [org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect((await as(t, who).post(`/api/events/${ev}/certificates/issue`)).status).toBe(403);
    }
    expect(
      (await request(t.app).post(`/api/events/${ev}/certificates/issue`).send({})).status,
    ).toBe(401);
    const running = await createPublishedEvent(t, org);
    const res = await as(t, org.organizer).post(`/api/events/${running}/certificates/issue`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_OVER');
    expect(
      (await as(t, org.organizer).post(`/api/events/${ev}/certificates/issue`, { x: 1 })).status,
    ).toBe(400);
  });

  it('shows the organizer, department staff and admins who has a certificate', async () => {
    const { ev } = await endedEvent(t, org, ['stayed', 'stayed', 'left_early']);
    await issue(ev);
    await workerFor(t).drain();
    for (const who of [org.organizer, org.faculty, org.hod, org.admin]) {
      const res = await as(t, who).get(`/api/events/${ev}/certificates`);
      expect(res.status).toBe(200);
      expect(res.body.summary).toEqual({
        eligible: 2,
        issued: 2,
        ready: 2,
        revoked: 0,
        canIssue: true,
      });
      expect(res.body.data).toHaveLength(2);
    }
    for (const who of [org.student, org.otherFaculty, org.otherHod]) {
      expect((await as(t, who).get(`/api/events/${ev}/certificates`)).status).toBe(403);
    }
    expect((await request(t.app).get(`/api/events/${ev}/certificates`)).status).toBe(401);
  });
});

describe('downloading a certificate', () => {
  it('lists my certificates and serves the PDF once the worker has drawn it', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed', 'stayed']);
    await issue(ev);
    await issueCertificates(t.ctx, { eventId: ev }); // rows exist, PDFs not drawn yet
    const mine = await as(t, people[0]!).get('/api/certificates');
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ status: 'pending', event: { id: ev } });
    const id = mine.body.data[0].id as string;
    const pending = await as(t, people[0]!).get(`/api/certificates/${id}/download`);
    expect(pending.status).toBe(202);
    expect(pending.body.data).toEqual({ status: 'pending' });

    await workerFor(t).drain();
    const ready = await as(t, people[0]!)
      .get(`/api/certificates/${id}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(ready.status).toBe(200);
    expect(ready.headers['content-type']).toBe('application/pdf');
    expect(ready.headers['content-disposition']).toContain('attachment');
    expect(ready.headers['cache-control']).toBe('no-store');
    expect((ready.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await as(t, people[0]!).get('/api/certificates')).body.data[0].status).toBe('ready');
  });

  it('shows a person only their own certificates', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed', 'stayed']);
    await issue(ev);
    await workerFor(t).drain();
    const idOfSecond = (await as(t, people[1]!).get('/api/certificates')).body.data[0].id as string;
    expect((await as(t, people[0]!).get(`/api/certificates/${idOfSecond}/download`)).status).toBe(
      404,
    );
    expect((await as(t, org.admin).get(`/api/certificates/${idOfSecond}/download`)).status).toBe(
      404,
    );
    expect((await request(t.app).get(`/api/certificates/${idOfSecond}/download`)).status).toBe(401);
    expect((await request(t.app).get('/api/certificates')).status).toBe(401);
    expect((await as(t, people[0]!).get('/api/certificates/not-a-uuid/download')).status).toBe(400);
    expect((await as(t, org.student).get('/api/certificates')).body.data).toEqual([]);
    expect((await as(t, people[0]!).get('/api/certificates?x=1')).status).toBe(400);
  });

  it('emails each person once with a link to their certificates, never with the code', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    await issue(ev);
    const w = workerFor(t);
    await w.drain();
    const mail = t.mailer.sent.filter((m) => m.subject.startsWith('Your certificate'));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe(people[0]!.user.email);
    expect(mail[0]!.text).toContain('/certificates');
    const [c] = await certs(ev);
    expect(mail[0]!.text).not.toContain(c.code);
  });
});

describe('what the certificate shows', () => {
  it('has the name, the event, the dates, the code and the verification address', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed'], { title: 'Annual Tech Symposium' });
    await nameOf(people[0]!.user.id, 'Priya Sharma');
    await issueCertificates(t.ctx, { eventId: ev });
    const [c] = await certs(ev);
    await generateCertificate(t.ctx, { certificateId: c.id }, { compress: false });
    const text = pdfText(pdfs()[0]!);
    for (const expected of [
      'Certificate of Participation',
      'Priya Sharma',
      'Annual Tech Symposium',
      `Certificate code: ${c.code}`,
      `/verify/${c.code}`,
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toMatch(/\/Subtype \/Image/);
  });

  it('draws very long names and other scripts without failing', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed', 'stayed']);
    await nameOf(people[0]!.user.id, 'Maximilian Alexander Bartholomew Montgomery-Fitzgerald III');
    await nameOf(people[1]!.user.id, 'अनुराग शर्मा');
    await issueCertificates(t.ctx, { eventId: ev });
    for (const c of await certs(ev))
      await expect(generateCertificate(t.ctx, { certificateId: c.id })).resolves.toBeUndefined();
    expect(pdfs()).toHaveLength(2);
  });
});

describe('correcting a name (regeneration)', () => {
  it('draws the PDF again with the new name, keeping the code, and removes the old file', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    await nameOf(people[0]!.user.id, 'Wrong Name');
    await issue(ev);
    await workerFor(t).drain();
    const [before] = await certs(ev);
    expect(before.holder_name).toBe('Wrong Name');
    const oldFile = pdfs()[0]!;

    await nameOf(people[0]!.user.id, 'Right Name');
    const res = await as(t, org.admin).post(`/api/certificates/${before.id}/regenerate`);
    expect(res.status).toBe(202);
    await workerFor(t).drain();

    const [after] = await certs(ev);
    expect(after).toMatchObject({ code: before.code, holder_name: 'Right Name', status: 'ready' });
    expect(after.storage_key).not.toBe(before.storage_key);
    expect(pdfs()).toHaveLength(1);
    expect(pdfs()[0]).not.toBe(oldFile);
    expect(await certs(ev)).toHaveLength(1);
    expect(await emails('certificate.ready')).toHaveLength(1); // the person is not emailed again
    expect(await audit('certificate.regenerated')).toHaveLength(1);
    const verified = await request(t.app).get(`/api/certificates/verify/${before.code}`);
    expect(verified.body.data.holderName).toBe('Right Name');
  });

  it('is for admins only', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed']);
    await issue(ev);
    await workerFor(t).drain();
    const [c] = await certs(ev);
    for (const who of [org.organizer, org.faculty, org.hod, people[0]!]) {
      expect((await as(t, who).post(`/api/certificates/${c.id}/regenerate`)).status).toBe(403);
    }
    expect(
      (await request(t.app).post(`/api/certificates/${c.id}/regenerate`).send({})).status,
    ).toBe(401);
    expect(
      (
        await as(t, org.admin).post(
          '/api/certificates/11111111-1111-4111-8111-111111111111/regenerate',
        )
      ).status,
    ).toBe(404);
  });
});

describe('verifying a certificate (AC-8.4)', () => {
  it('confirms a genuine code, with no sign-in, and shows only what is printed on it', async () => {
    const { ev, people } = await endedEvent(t, org, ['stayed'], { title: 'Verified Event' });
    await nameOf(people[0]!.user.id, 'Vera Verified');
    await issue(ev);
    await workerFor(t).drain();
    const [c] = await certs(ev);
    const res = await request(t.app).get(`/api/certificates/verify/${c.code}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      valid: true,
      code: c.code,
      holderName: 'Vera Verified',
      eventTitle: 'Verified Event',
    });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(people[0]!.user.email);
    expect(text).not.toContain(people[0]!.user.id);
  });

  it('accepts the code however it is typed', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    await issue(ev);
    await workerFor(t).drain();
    const [c] = await certs(ev);
    for (const variant of [
      c.code.toLowerCase(),
      c.code.replace(/-/g, ''),
      ` ${c.code.replace(/-/g, ' ')} `,
    ]) {
      expect(
        (await request(t.app).get(`/api/certificates/verify/${encodeURIComponent(variant)}`))
          .status,
      ).toBe(200);
    }
  });

  it('answers a random, malformed or revoked-looking code with the same "not found"', async () => {
    const answers = [];
    for (const code of [
      '0000-0000-0000-0000',
      'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
      'nope',
      '12345',
      'a'.repeat(40),
    ]) {
      const res = await request(t.app).get(`/api/certificates/verify/${code}`);
      expect(res.status, code).toBe(404);
      expect(res.body.error.code).toBe('CERTIFICATE_NOT_FOUND');
      answers.push(res.body.error.message);
    }
    expect(new Set(answers).size).toBe(1);
    expect((await request(t.app).get(`/api/certificates/verify/${'a'.repeat(65)}`)).status).toBe(
      400,
    );
  });

  it('limits how often anyone can try codes (429), so valid codes cannot be found by guessing', async () => {
    const limited = buildTestApp({ VERIFY_RATE_LIMIT_MAX: '3' });
    try {
      for (let i = 0; i < 3; i++) {
        expect(
          (await request(limited.app).get('/api/certificates/verify/0000-0000-0000-0000')).status,
        ).toBe(404);
      }
      const blocked = await request(limited.app).get(
        '/api/certificates/verify/0000-0000-0000-0000',
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
