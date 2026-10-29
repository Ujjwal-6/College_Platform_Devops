import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateGatePass, registerGatePassHandlers } from '../src/modules/attendance/gatepass.js';
import { renderGatePass } from '../src/modules/attendance/pdf.js';
import { qrPng } from '../src/modules/attendance/qr.js';
import { registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import { JobWorker, PermanentJobError } from '../src/platform/jobs/worker.js';
import {
  as,
  buildOrg,
  buildTestApp,
  createConfirmedBooking,
  createHall,
  resetDb,
  type Org,
} from './helpers.js';
import {
  createPublishedEvent,
  createTeam,
  joinTeam,
  post,
  register,
  students,
  teamEvent,
} from './registration-helpers.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const t = buildTestApp();
let org: Org;
beforeEach(async () => {
  rmSync(t.ctx.config.STORAGE_DIR, { recursive: true, force: true }); // PDFs of earlier tests
  await resetDb(t.ctx);
  org = await buildOrg(t);
});
afterAll(() => t.close());

const q = async (sql: string, params: unknown[] = []) => (await t.ctx.pool.query(sql, params)).rows;
const jobs = (type: string) => q('SELECT * FROM jobs WHERE type = $1', [type]);
const emails = (n: string) =>
  q("SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'notification' = $1", [n]);
const worker = () => {
  const w = new JobWorker({
    pool: t.ctx.pool,
    logger: t.ctx.logger,
    lockSeconds: 60,
    backoffBaseSeconds: 1,
    pollIntervalMs: 100,
    backoffSeconds: () => 0,
  });
  registerNotificationHandlers(w, t.mailer);
  registerGatePassHandlers(w, t.ctx);
  return w;
};
const storedPdfs = () => {
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

async function registered(over: Record<string, unknown> = {}) {
  const ev = await createPublishedEvent(t, org, over);
  const [sam] = await students(t, 1);
  const reg = (await register(t, sam!, ev)).body.data.id as string;
  return { ev, sam: sam!, reg };
}

describe('asking for a gate pass', () => {
  it('queues one job when a registration is confirmed, and makes no PDF in the request (AC-7.5)', async () => {
    const { reg } = await registered();
    const queued = await jobs('gate_pass.generate');
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ registrationId: reg });
    expect(queued[0].job_key).toBe(`gate-pass:${reg}`);
    expect(await q('SELECT 1 FROM gate_passes')).toHaveLength(0);
    expect(storedPdfs()).toHaveLength(0);
  });

  it('queues one job per person for teams, and one for a person promoted from the waitlist', async () => {
    const ev = await createPublishedEvent(t, org, teamEvent());
    const [lead, member] = await students(t, 2);
    const created = await createTeam(t, lead!, ev, 'Pass Holders');
    await joinTeam(t, member!, created.body.data.invitationCode);
    expect(await jobs('gate_pass.generate')).toHaveLength(2);

    const solo = await createPublishedEvent(t, org, { capacity: 1 });
    const [holder, waiting] = await students(t, 2);
    const held = await register(t, holder!, solo);
    await post(t, waiting!, `/api/events/${solo}/registrations`, { waitlist: true });
    expect(await jobs('gate_pass.generate')).toHaveLength(3); // the waiting person has no pass yet
    await post(t, holder!, `/api/registrations/${held.body.data.id}/cancel`);
    expect(await jobs('gate_pass.generate')).toHaveLength(4); // promoted: now they do
  });

  it('does not queue a second job when someone cancels and registers again', async () => {
    const { ev, sam, reg } = await registered();
    await post(t, sam, `/api/registrations/${reg}/cancel`);
    await register(t, sam, ev);
    expect(await jobs('gate_pass.generate')).toHaveLength(1);
  });
});

describe('the worker making the pass (FR-7.3)', () => {
  it('renders and stores a PDF, records it, and emails a link; then the registrant downloads it', async () => {
    const { ev, sam, reg } = await registered();
    const pending = await as(t, sam).get(`/api/registrations/${reg}/gate-pass`);
    expect(pending.status).toBe(202);
    expect(pending.body.data).toEqual({ status: 'pending' });

    await worker().drain();
    const [row] = await q('SELECT * FROM gate_passes');
    expect(row.registration_id).toBe(reg);
    expect(storedPdfs()).toHaveLength(1);
    expect(readFileSync(storedPdfs()[0]!).subarray(0, 5).toString()).toBe('%PDF-');

    const mail = t.mailer.sent.filter((m) => m.subject.startsWith('Your gate pass'));
    expect(mail).toHaveLength(1);
    expect(mail[0]!.to).toBe(sam.user.email);
    expect(mail[0]!.text).toContain(`/events/${ev}`);
    expect(mail[0]!.text).not.toMatch(/EQ1\./); // the link points at the page; the code itself is never emailed

    const pass = await as(t, sam)
      .get(`/api/registrations/${reg}/gate-pass`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pass.status).toBe(200);
    expect(pass.headers['content-type']).toBe('application/pdf');
    expect(pass.headers['content-disposition']).toContain('attachment');
    expect(pass.headers['cache-control']).toBe('no-store');
    expect((pass.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await as(t, sam).get(`/api/registrations/${reg}/qr`)).body.data.gatePassReady).toBe(
      true,
    );
  });

  it('gives the pass only to its holder', async () => {
    const { reg, sam } = await registered();
    await worker().drain();
    const [other] = await students(t, 1);
    expect((await as(t, other!).get(`/api/registrations/${reg}/gate-pass`)).status).toBe(404);
    expect((await as(t, org.admin).get(`/api/registrations/${reg}/gate-pass`)).status).toBe(404);
    expect((await request(t.app).get(`/api/registrations/${reg}/gate-pass`)).status).toBe(401);
    expect((await as(t, sam).get('/api/registrations/not-a-uuid/gate-pass')).status).toBe(400);
  });

  it('stops serving the pass once the registration is cancelled', async () => {
    const { reg, sam } = await registered();
    await worker().drain();
    await post(t, sam, `/api/registrations/${reg}/cancel`);
    const res = await as(t, sam).get(`/api/registrations/${reg}/gate-pass`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_NOT_ACTIVE');
  });

  it('makes no pass for a registration cancelled before the worker got to it', async () => {
    const { reg, sam } = await registered();
    await post(t, sam, `/api/registrations/${reg}/cancel`);
    await worker().drain();
    expect(await q('SELECT 1 FROM gate_passes')).toHaveLength(0);
    expect(storedPdfs()).toHaveLength(0);
    expect(await emails('gate_pass.ready')).toHaveLength(0);
    expect((await jobs('gate_pass.generate'))[0].status).toBe('succeeded');
  });

  it('is safe to run twice: one stored file, one record, one email', async () => {
    const { reg } = await registered();
    await generateGatePass(t.ctx, { registrationId: reg });
    await generateGatePass(t.ctx, { registrationId: reg });
    expect(await q('SELECT 1 FROM gate_passes')).toHaveLength(1);
    expect(storedPdfs()).toHaveLength(1);
    expect(await emails('gate_pass.ready')).toHaveLength(1);
  });

  it('ends with one stored file when two workers generate it at the same moment', async () => {
    const { reg } = await registered();
    await Promise.all(
      Array.from({ length: 5 }, () => generateGatePass(t.ctx, { registrationId: reg })),
    );
    expect(await q('SELECT 1 FROM gate_passes')).toHaveLength(1);
    expect(storedPdfs()).toHaveLength(1);
    expect(await emails('gate_pass.ready')).toHaveLength(1);
  });

  it('fails a malformed or unknown job for good instead of retrying it', async () => {
    await expect(generateGatePass(t.ctx, { registrationId: 'nope' })).rejects.toBeInstanceOf(
      PermanentJobError,
    );
    await expect(generateGatePass(t.ctx, {})).rejects.toBeInstanceOf(PermanentJobError);
    await expect(
      generateGatePass(t.ctx, { registrationId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toBeInstanceOf(PermanentJobError);
    await q("INSERT INTO jobs (type, payload) VALUES ('gate_pass.generate', '{}')");
    await worker().drain();
    expect((await jobs('gate_pass.generate'))[0].status).toBe('failed');
  });
});

describe('what the PDF shows (AC-7.5)', () => {
  /** The text shown on the page. pdfkit writes it as hex strings (`<416e6e75616c>`), possibly split by kerning. */
  const read = (file: string) => {
    const raw = readFileSync(file).toString('latin1');
    const shown = [...raw.matchAll(/<([0-9a-f]{2,})>/gi)]
      .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
      .join('');
    return `${raw}\n${shown}`;
  };

  it('has the event, date, venue, holder, team and a QR image', async () => {
    const ev = await createPublishedEvent(t, org, { ...teamEvent(), title: 'Annual Hack Night' });
    const hall = await createHall(t, org.admin, { name: 'Main Auditorium', capacity: 500 });
    await createConfirmedBooking(t, org, ev, hall);
    const [lead] = await students(t, 1);
    await q("UPDATE users SET name = 'Priya Sharma' WHERE id = $1", [lead!.user.id]);
    const created = await createTeam(t, lead!, ev, 'Gate Crashers');

    await generateGatePass(
      t.ctx,
      { registrationId: created.body.data.registration.id },
      { compress: false },
    );
    const text = read(storedPdfs()[0]!);
    for (const expected of [
      'Annual Hack Night',
      'Main Auditorium',
      'Priya Sharma',
      'Gate Crashers',
      'EVENT GATE PASS',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toMatch(/When/);
    expect(text).toMatch(/\/Subtype \/Image/); // the QR code
  });

  it('says the venue is to be announced when no hall is booked', async () => {
    const { reg } = await registered();
    await generateGatePass(t.ctx, { registrationId: reg }, { compress: false });
    expect(read(storedPdfs()[0]!)).toContain('To be announced');
  });

  it('draws names in other scripts without failing (they are not shown correctly, a documented limit)', async () => {
    const { reg, sam } = await registered();
    await q("UPDATE users SET name = 'अनुराग शर्मा' WHERE id = $1", [sam.user.id]);
    await expect(generateGatePass(t.ctx, { registrationId: reg })).resolves.toBeUndefined();
    expect(storedPdfs()).toHaveLength(1);
  });

  it('draws a PDF from plain data, and the QR image is a PNG', async () => {
    const png = await qrPng('EQ1.example.token');
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    const pdf = await renderGatePass(
      {
        eventTitle: 'Title',
        when: 'Today',
        venue: 'Hall',
        holderName: 'Name',
        teamName: null,
        validUntil: 'Tomorrow',
        passId: 'ABCD1234',
        qrPng: png,
      },
      { compress: false },
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.toString('latin1')).not.toContain('Team:');
  });
});
