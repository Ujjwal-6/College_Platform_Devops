import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { qrPng } from '../src/modules/attendance/qr.js';
import { registerEventHook } from '../src/modules/events/index.js';
import { generateReport, registerReportHandlers } from '../src/modules/reports/handlers.js';
import { errors } from '../src/platform/errors.js';
import { JobWorker } from '../src/platform/jobs/worker.js';
import { registerNotificationHandlers } from '../src/modules/notifications/notify.js';
import {
  as,
  bearer,
  buildOrg,
  buildTestApp,
  createHall,
  resetDb,
  type LoggedIn,
  type Org,
} from './helpers.js';
import { endedEvent, workerFor, type Presence } from './aftermath-helpers.js';
import { sessionFor } from './registration-helpers.js';

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
const reports = (ev: string) =>
  q('SELECT * FROM event_reports WHERE event_id = $1 ORDER BY version', [ev]);
const jobs = (type = 'report.generate') =>
  q('SELECT * FROM jobs WHERE type = $1 ORDER BY created_at', [type]);
const audit = (a: string) => q('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [a]);
const emails = (n: string) =>
  q("SELECT payload FROM jobs WHERE type = 'email.send' AND payload->>'notification' = $1", [n]);
const storedFiles = (ext?: string) => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!ext || e.name.endsWith(ext)) out.push(p);
    }
  };
  try {
    walk(t.ctx.config.STORAGE_DIR);
  } catch {
    // nothing stored yet
  }
  return out;
};
/** The page's text: pdfkit writes it as hex strings, possibly split by kerning. */
const textOf = (file: string) => {
  const raw = readFileSync(file).toString('latin1');
  const shown = [...raw.matchAll(/<([0-9a-f]{2,})>/gi)]
    .map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'))
    .join('');
  return `${raw}\n${shown}`;
};
const images = (text: string) => (text.match(/\/Subtype \/Image/g) ?? []).length;
const fileOf = async (reportId: string) =>
  path.join(
    t.ctx.config.STORAGE_DIR,
    (await q('SELECT storage_key FROM event_reports WHERE id = $1', [reportId]))[0]
      .storage_key as string,
  );
const closeEvent = (ev: string, who: LoggedIn = org.organizer) =>
  as(t, who).post(`/api/events/${ev}/close`);
const drawNow = async (reportId: string) =>
  generateReport(t.ctx, { reportId }, { compress: false });

/** An event that ran and was closed, so its automatic report is queued. */
async function closed(kinds: Presence[], over: Record<string, unknown> = {}) {
  const e = await endedEvent(t, org, kinds, over);
  expect((await closeEvent(e.ev)).status).toBe(200);
  const [report] = await reports(e.ev);
  return { ...e, report };
}
const png = () => qrPng('a stand-in for a photograph');
const photo = (
  who: LoggedIn,
  ev: string,
  data: Buffer | string,
  type = 'image/png',
  caption?: string,
) => {
  const r = request(t.app)
    .post(
      `/api/events/${ev}/report/photos${caption ? `?caption=${encodeURIComponent(caption)}` : ''}`,
    )
    .set(bearer(who.accessToken))
    .set('Content-Type', type);
  return r.send(data);
};

describe('the automatic report when an event closes (AT-19.1, AT-19.9)', () => {
  it('queues exactly one job and one pending version, and closing does not wait for the PDF', async () => {
    const { ev, report } = await closed(['stayed']);
    expect(report).toMatchObject({
      version: 1,
      reason: 'close',
      status: 'pending',
      requested_by: null,
    });
    expect(await jobs()).toHaveLength(1);
    expect((await jobs())[0].payload).toEqual({ reportId: report.id });
    expect(storedFiles('.pdf')).toHaveLength(0); // the request returned with no PDF made
    expect((await q('SELECT status FROM events WHERE id = $1', [ev]))[0].status).toBe('closed');
  });

  it('draws a PDF with the numbers: 10 registered, 8 attended, 80% (AT-19.1)', async () => {
    const kinds: Presence[] = [
      'stayed',
      'stayed',
      'stayed',
      'stayed',
      'left_early',
      'left_early',
      'inside',
      'inside',
      'absent',
      'absent',
    ];
    const { ev, report } = await closed(kinds, {
      title: 'Annual Tech Symposium',
      speakers: [
        { name: 'Dr Meera Nair', designation: 'Professor', organization: 'IIT Madras' },
        { name: 'Arun Kapoor', designation: null, organization: null },
      ],
    });
    const hall = await createHall(t, org.admin, { name: 'Main Auditorium', capacity: 500 });
    await q(
      "INSERT INTO hall_bookings (event_id, hall_id, requested_by, event_organizer_id, department_id, start_at, end_at, status) SELECT id, $2, organizer_id, organizer_id, department_id, start_at, end_at, 'confirmed' FROM events WHERE id = $1",
      [ev, hall],
    );

    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    for (const expected of [
      'POST-EVENT REPORT',
      'Annual Tech Symposium',
      'Main Auditorium',
      'Computer Science',
      'Dr Meera Nair',
      'Professor, IIT Madras',
      'Arun Kapoor',
      'Registered: 10',
      'Checked in: 8',
      '80.0% (checked in',
      'Registered but did not come: 2',
      'Stayed to the end: 4',
      'Left early: 2',
      'Not checked out: 2',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect((await reports(ev))[0]).toMatchObject({ status: 'ready' });
  });

  it('counts walk-ins and by-hand check-ins, and says when check-out was not required', async () => {
    const { ev, report, regs } = await closed(['stayed', 'stayed', 'stayed']);
    await q("UPDATE attendance SET method = 'walk_in' WHERE registration_id = $1", [regs[0]]);
    await q(
      "UPDATE attendance SET method = 'manual', reason = 'Pass would not scan' WHERE registration_id = $1",
      [regs[1]],
    );
    await q(
      'INSERT INTO event_attendance_settings (event_id, require_check_out, updated_by) VALUES ($1, false, $2)',
      [ev, org.organizer.user.id],
    );
    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    expect(text).toContain('Walk-ins (not registered beforehand): 1');
    expect(text).toContain('Checked in by hand: 1');
    expect(text).toContain('Check-out was not required for this event');
    expect(text).not.toContain('Left early:');
  });

  it('tells the organizer and every admin when it is ready, once each', async () => {
    const { report } = await closed(['stayed']);
    await workerFor(t).drain();
    const mails = t.mailer.sent.filter((m) => m.subject.startsWith('Post-event report ready'));
    expect(mails.map((m) => m.to).sort()).toEqual(
      [org.organizer.user.email, org.admin.user.email, org.admin2.user.email].sort(),
    );
    expect((await reports(report.event_id))[0].status).toBe('ready');
    expect(await audit('report.generated')).toHaveLength(1);
  });
});

describe('missing information does not fail the report (AT-19.2)', () => {
  it('says so in every section when there are no photographs, no feedback, no outcomes and no certificates', async () => {
    const { report } = await closed(['stayed']);
    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    for (const expected of [
      'No photographs provided.',
      'No feedback received.',
      'No outcomes provided.',
      'No certificates have been issued yet.',
      'No speakers listed.',
    ]) {
      expect(text, expected).toContain(expected);
    }
  });

  it('copes with an event nobody registered for', async () => {
    const { report } = await closed([]);
    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    expect(text).toContain('Registered: 0');
    expect(text).toContain('Not available (nobody registered)');
    expect(text).toContain('No attendance was recorded for this event.');
    expect(text).toContain('Registered but did not come: 0');
  });

  it('shows the venue as not provided when no hall was booked', async () => {
    const { report } = await closed(['stayed']);
    await drawNow(report.id);
    expect(textOf(await fileOf(report.id))).toContain('Venue: Not provided');
  });
});

describe('what the organizer adds', () => {
  it('shows the outcomes text and the feedback with its comments, but never who wrote them', async () => {
    const { ev, people, report } = await closed(['stayed', 'stayed', 'stayed']);
    await as(t, org.organizer).put(`/api/events/${ev}/report/outcomes`, {
      outcomes: 'Forty teams took part and six prototypes were demonstrated.',
    });
    for (const [i, rating, comment] of [
      [0, 5, 'Excellent speakers'],
      [1, 4, null],
      [2, 3, 'Too crowded'],
    ] as const) {
      await q('INSERT INTO feedback (event_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)', [
        ev,
        people[i]!.user.id,
        rating,
        comment,
      ]);
    }
    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    for (const expected of [
      'Forty teams took part',
      'Responses: 3',
      'Average rating: 4.0 out of 5',
      '5 stars: 1',
      'Excellent speakers',
      'Too crowded',
      'Comments (anonymous)',
    ]) {
      expect(text, expected).toContain(expected);
    }
    for (const p of people) {
      expect(text).not.toContain(p.user.email);
      expect(text).not.toContain(p.user.id);
    }
  });

  it('counts the certificates that were issued and withdrawn', async () => {
    const { ev, report, people } = await closed(['stayed', 'stayed']);
    await as(t, org.organizer).post(`/api/events/${ev}/certificates/issue`);
    await workerFor(t).drain();
    const certId = (
      await q('SELECT id FROM certificates WHERE user_id = $1', [people[0]!.user.id])
    )[0].id;
    await as(t, org.organizer).post(`/api/certificates/${certId}/revoke`, {
      reason: 'Recorded by mistake',
    });
    const next = await as(t, org.organizer).post(`/api/events/${ev}/reports`);
    expect(next.status).toBe(202);
    void report;
    const [, v2] = await reports(ev);
    await drawNow(v2.id); // drawn here, uncompressed, so its text can be read
    const text = textOf(await fileOf(v2.id));
    expect(text).toContain('Issued: 2');
    expect(text).toContain('Withdrawn: 1');
  });

  it('includes the photographs, with captions', async () => {
    const { ev, report } = await closed(['stayed']);
    expect(
      (await photo(org.organizer, ev, await png(), 'image/png', 'The opening session')).status,
    ).toBe(201);
    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    expect(text).toContain('The opening session');
    expect(text).not.toContain('No photographs provided.');
    expect(images(text)).toBeGreaterThan(0);
  });

  it('is not stopped by a photograph that cannot be read', async () => {
    const { ev, report } = await closed(['stayed']);
    const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(80, 7)]); // looks like a JPEG, is not
    expect((await photo(org.organizer, ev, corrupt, 'image/jpeg')).status).toBe(201);
    await photo(org.organizer, ev, await png(), 'image/png', 'A good one');
    await drawNow(report.id);
    const text = textOf(await fileOf(report.id));
    expect(text).toContain('1 photograph could not be included.');
    expect(text).toContain('A good one');
    expect((await reports(ev))[0].status).toBe('ready');
  });

  it('still makes the report when a stored photograph file has gone missing', async () => {
    const { ev, report } = await closed(['stayed']);
    await photo(org.organizer, ev, await png(), 'image/png');
    for (const f of storedFiles('.png')) rmSync(f);
    await drawNow(report.id);
    expect((await reports(ev))[0].status).toBe('ready');
  });
});

describe('closing twice and delivering twice (AT-19.3)', () => {
  it('makes one version, one job, one file and one set of emails', async () => {
    const { ev, report } = await closed(['stayed']);
    const again = await closeEvent(ev);
    expect(again.status).not.toBe(500);
    expect(await reports(ev)).toHaveLength(1);
    expect(await jobs()).toHaveLength(1);

    const w = workerFor(t);
    await w.drain();
    await generateReport(t.ctx, { reportId: report.id });
    await generateReport(t.ctx, { reportId: report.id });
    await Promise.all(
      Array.from({ length: 4 }, () => generateReport(t.ctx, { reportId: report.id })),
    );
    expect(storedFiles('.pdf')).toHaveLength(1);
    expect(await emails('report.ready')).toHaveLength(3);
    expect(await audit('report.generated')).toHaveLength(1);
  });

  it('is protected by the database: a second automatic report for a close is refused', async () => {
    const { ev } = await closed(['stayed']);
    await expect(
      q("INSERT INTO event_reports (event_id, version, reason) VALUES ($1, 2, 'close')", [ev]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'event_reports_one_close_key' });
  });
});

describe('retries and failures (AT-19.4)', () => {
  const workerWith = (render: (...a: never[]) => Promise<Buffer>) => {
    const w = new JobWorker({
      pool: t.ctx.pool,
      logger: t.ctx.logger,
      lockSeconds: 60,
      backoffBaseSeconds: 1,
      pollIntervalMs: 100,
      backoffSeconds: () => 0,
    });
    registerNotificationHandlers(w, t.mailer);
    registerReportHandlers(w, t.ctx, { render: render as never });
    return w;
  };

  it('retries a renderer that fails twice and succeeds on the third attempt', async () => {
    const { ev } = await closed(['stayed']);
    let calls = 0;
    const flaky = async (): Promise<Buffer> => {
      if (++calls <= 2) throw new Error('renderer crashed');
      return Buffer.from('%PDF-1.3\n%fake but valid enough\n');
    };
    await workerWith(flaky).drain();
    expect(calls).toBe(3);
    const [report] = await reports(ev);
    expect(report.status).toBe('ready');
    const [job] = await jobs();
    expect(job).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(await q("SELECT 1 FROM audit_log WHERE action = 'report.failed'")).toHaveLength(0);
  });

  it('marks the version failed after the last attempt, tells the organizer and admins, and can be asked for again', async () => {
    const { ev } = await closed(['stayed']);
    const broken = async (): Promise<Buffer> => {
      throw new Error('disk full');
    };
    await workerWith(broken).drain();
    const [report] = await reports(ev);
    expect(report).toMatchObject({ status: 'failed' });
    expect(report.error).toContain('disk full');
    expect((await jobs())[0]).toMatchObject({ status: 'failed', attempts: 5 });
    expect(await audit('report.failed')).toHaveLength(1);
    const mails = t.mailer.sent.filter((m) =>
      m.subject.startsWith('Post-event report could not be made'),
    );
    expect(mails.map((m) => m.to).sort()).toEqual(
      [org.organizer.user.email, org.admin.user.email, org.admin2.user.email].sort(),
    );

    const dl = await as(t, org.organizer).get(`/api/event-reports/${report.id}/download`);
    expect(dl.status).toBe(409);
    expect(dl.body.error.code).toBe('REPORT_FAILED');

    const again = await as(t, org.organizer).post(`/api/events/${ev}/reports`);
    expect(again.status).toBe(202);
    expect(again.body.data.version).toBe(2);
    await workerFor(t).drain();
    expect((await reports(ev)).map((r) => r.status)).toEqual(['failed', 'ready']);
  });

  it('fails a malformed or unknown job for good instead of retrying it', async () => {
    await expect(generateReport(t.ctx, { reportId: 'nope' })).rejects.toThrow();
    await expect(
      generateReport(t.ctx, { reportId: '11111111-1111-4111-8111-111111111111' }),
    ).rejects.toThrow();
  });
});

describe('a close that is rolled back (AT-19.5)', () => {
  it('leaves no report and no job behind', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    const remove = registerEventHook(async (_tx, { action }) => {
      if (action === 'close') throw errors.conflict('NOPE', 'Something else refused the close');
    });
    try {
      const res = await closeEvent(ev);
      expect(res.status).toBe(409);
    } finally {
      remove();
    }
    expect(await reports(ev)).toHaveLength(0);
    expect(await jobs()).toHaveLength(0);
    expect((await q('SELECT status FROM events WHERE id = $1', [ev]))[0].status).toBe('published');
  });
});

describe('who may see and download it (AT-19.6)', () => {
  it('lets the organizer, department staff and admins in, and refuses everyone else', async () => {
    const { ev, report } = await closed(['stayed']);
    await workerFor(t).drain();
    for (const who of [org.organizer, org.faculty, org.hod, org.admin]) {
      expect((await as(t, who).get(`/api/events/${ev}/report`)).status).toBe(200);
      const dl = await as(t, who).get(`/api/event-reports/${report.id}/download`);
      expect(dl.status).toBe(200);
      expect(dl.headers['content-type']).toBe('application/pdf');
    }
    const outsiders = [
      org.student,
      org.otherFaculty,
      org.otherHod,
      org.otherOrganizer,
      await sessionFor(t),
    ];
    for (const who of outsiders) {
      expect((await as(t, who).get(`/api/events/${ev}/report`)).status).toBe(403);
      expect((await as(t, who).get(`/api/event-reports/${report.id}/download`)).status).toBe(403);
      expect(
        (
          await as(t, who).get(
            `/api/events/${ev}/report/photos/11111111-1111-4111-8111-111111111111`,
          )
        ).status,
      ).toBe(403);
    }
    expect((await request(t.app).get(`/api/events/${ev}/report`)).status).toBe(401);
    expect((await request(t.app).get(`/api/event-reports/${report.id}/download`)).status).toBe(401);
  });

  it('serves the PDF with safe headers, 202 while pending, 404 for an unknown or malformed id', async () => {
    const { report } = await closed(['stayed']);
    const pending = await as(t, org.organizer).get(`/api/event-reports/${report.id}/download`);
    expect(pending.status).toBe(202);
    expect(pending.body.data).toEqual({ status: 'pending' });
    await workerFor(t).drain();
    const ready = await as(t, org.organizer)
      .get(`/api/event-reports/${report.id}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(ready.headers['content-disposition']).toContain('event-report-v1.pdf');
    expect(ready.headers['cache-control']).toBe('no-store');
    expect(ready.headers['x-content-type-options']).toBe('nosniff');
    expect((ready.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect(
      (
        await as(t, org.organizer).get(
          '/api/event-reports/11111111-1111-4111-8111-111111111111/download',
        )
      ).status,
    ).toBe(404);
    expect((await as(t, org.organizer).get('/api/event-reports/not-a-uuid/download')).status).toBe(
      400,
    );
  });
});

describe('hostile and very long text (AT-19.7)', () => {
  it('draws markup as plain text and copes with very long text and names', async () => {
    const title = '<script>alert("x")</script> & "quotes" <img src=x onerror=alert(1)>';
    const { ev, report, people } = await closed(['stayed', 'stayed'], {
      title,
      description: 'Long description. '.repeat(120),
      speakers: [
        { name: 'S'.repeat(90), designation: 'D'.repeat(90), organization: 'O'.repeat(90) },
      ],
    });
    await as(t, org.organizer).put(`/api/events/${ev}/report/outcomes`, {
      outcomes: '<b>bold?</b> '.repeat(200),
    });
    await q('INSERT INTO feedback (event_id, user_id, rating, comment) VALUES ($1, $2, 5, $3)', [
      ev,
      people[0]!.user.id,
      '<script>steal()</script> '.repeat(30),
    ]);
    await expect(drawNow(report.id)).resolves.toBeUndefined();
    const text = textOf(await fileOf(report.id));
    expect(text).toContain('<script>alert("x")</script>');
    expect(text).toContain('<b>bold?</b>');
    expect(text).toContain('<script>steal()</script>');
    expect(text.match(/\/Type \/Page\b(?!s)/g)!.length).toBeGreaterThanOrEqual(1);
    expect((await reports(ev))[0].status).toBe('ready');
  });
});

describe('late photographs and new versions (AT-19.8)', () => {
  it('makes version 2 with the new photograph and keeps version 1 as it was', async () => {
    const { ev, report } = await closed(['stayed']);
    await drawNow(report.id);
    const v1File = await fileOf(report.id);
    const v1Images = images(textOf(v1File));
    expect(v1Images).toBe(0);

    expect((await photo(org.organizer, ev, await png(), 'image/png', 'Late photo')).status).toBe(
      201,
    );
    const res = await as(t, org.organizer).post(`/api/events/${ev}/reports`);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ version: 2, status: 'pending', reason: 'manual' });
    const [, v2] = await reports(ev);
    await drawNow(v2.id);

    expect(images(textOf(await fileOf(v2.id)))).toBeGreaterThan(0);
    expect(textOf(await fileOf(v2.id))).toContain('Late photo');
    expect(images(textOf(v1File))).toBe(0); // version 1 is unchanged
    expect((await reports(ev)).map((r) => [r.version, r.status])).toEqual([
      [1, 'ready'],
      [2, 'ready'],
    ]);
    expect(storedFiles('.pdf')).toHaveLength(2);
    expect(
      (await as(t, org.organizer).get(`/api/event-reports/${report.id}/download`)).status,
    ).toBe(200);
  });

  it('is for the organizer and admins, after the event closed, one at a time', async () => {
    const { ev } = await closed(['stayed']);
    await workerFor(t).drain();
    for (const who of [org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect((await as(t, who).post(`/api/events/${ev}/reports`)).status).toBe(403);
    }
    expect((await request(t.app).post(`/api/events/${ev}/reports`).send({})).status).toBe(401);
    expect((await as(t, org.organizer).post(`/api/events/${ev}/reports`, { x: 1 })).status).toBe(
      400,
    );

    const results = await Promise.all(
      [org.organizer, org.admin, org.admin2, org.organizer, org.admin].map((who) =>
        as(t, who).post(`/api/events/${ev}/reports`),
      ),
    );
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 202)
        .every((r) => r.body.error.code === 'REPORT_IN_PROGRESS'),
    ).toBe(true);
    expect((await reports(ev)).map((r) => r.version)).toEqual([1, 2]);
  });

  it('is refused before the event is closed', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    const res = await as(t, org.organizer).post(`/api/events/${ev}/reports`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_CLOSED');
  });

  it('shows the versions, who asked, and what the viewer may do', async () => {
    const { ev } = await closed(['stayed']);
    await workerFor(t).drain();
    await as(t, org.admin).post(`/api/events/${ev}/reports`);
    const asAdmin = await as(t, org.admin).get(`/api/events/${ev}/report`);
    expect(
      asAdmin.body.data.reports.map(
        (r: { version: number; status: string; requestedBy: string | null }) => [
          r.version,
          r.status,
          r.requestedBy ? 'someone' : 'system',
        ],
      ),
    ).toEqual([
      [2, 'pending', 'someone'],
      [1, 'ready', 'system'],
    ]);
    expect(asAdmin.body.data.can).toEqual({ edit: true, generate: false }); // one is already being made
    expect(asAdmin.body.data.limits).toEqual({ photoMaxBytes: 5_000_000, photoMaxCount: 20 });
    await workerFor(t).drain();
    const asFaculty = await as(t, org.faculty).get(`/api/events/${ev}/report`);
    expect(asFaculty.body.data.can).toEqual({ edit: false, generate: false });
    expect((await as(t, org.organizer).get(`/api/events/${ev}/report`)).body.data.can).toEqual({
      edit: true,
      generate: true,
    });
  });
});

describe('photographs (U-7: JPEG or PNG, 5 MB, 20 per event)', () => {
  const published = async () => (await endedEvent(t, org, ['stayed'])).ev;

  it('accepts a photograph before the event is closed, lists it and lets staff see it', async () => {
    const ev = await published();
    const res = await photo(org.organizer, ev, await png(), 'image/png', 'Backstage');
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ caption: 'Backstage' });
    const list = (await as(t, org.faculty).get(`/api/events/${ev}/report`)).body.data.photos;
    expect(list).toHaveLength(1);
    const image = await as(t, org.faculty)
      .get(`/api/events/${ev}/report/photos/${res.body.data.id}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.headers['cache-control']).toBe('private, no-store');
    expect(await audit('report.photo_added')).toHaveLength(1);
  });

  it('checks what the file really is, how large it is and how it was sent', async () => {
    const ev = await published();
    const svg = await photo(org.organizer, ev, '<svg onload=alert(1)></svg>', 'image/png');
    expect(svg.status).toBe(422);
    expect(svg.body.error.code).toBe('INVALID_FILE');
    expect(
      (await photo(org.organizer, ev, Buffer.from('%PDF-1.3 not an image'), 'image/jpeg')).status,
    ).toBe(422);
    expect((await photo(org.organizer, ev, await png(), 'text/plain')).status).toBe(400);
    const big = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(5_100_000),
    ]);
    expect((await photo(org.organizer, ev, big, 'image/png')).status).toBe(413);
    expect((await photo(org.organizer, ev, await png(), 'image/png', 'x'.repeat(201))).status).toBe(
      400,
    );
    expect(
      (
        await request(t.app)
          .post(`/api/events/${ev}/report/photos?other=1`)
          .set(bearer(org.organizer.accessToken))
          .set('Content-Type', 'image/png')
          .send(await png())
      ).status,
    ).toBe(400);
    expect(storedFiles()).toHaveLength(0);
    expect(await q('SELECT 1 FROM event_photos')).toHaveLength(0);
  });

  it('stops at 20, even when many arrive at once, and leaves no stray files', async () => {
    const ev = await published();
    const data = await png();
    for (let i = 0; i < 18; i++) expect((await photo(org.organizer, ev, data)).status).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => photo(org.organizer, ev, data)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(
      results
        .filter((r) => r.status !== 201)
        .every((r) => r.status === 409 && r.body.error.code === 'TOO_MANY_PHOTOS'),
    ).toBe(true);
    expect(await q('SELECT 1 FROM event_photos')).toHaveLength(20);
    expect(storedFiles()).toHaveLength(20);
  });

  it('is for the organizer and admins; others cannot add, see or remove them', async () => {
    const ev = await published();
    const added = await photo(org.organizer, ev, await png());
    const id = added.body.data.id as string;
    for (const who of [org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect((await photo(who, ev, await png())).status).toBe(403);
      expect((await as(t, who).delete(`/api/events/${ev}/report/photos/${id}`)).status).toBe(403);
    }
    expect(
      (
        await request(t.app)
          .post(`/api/events/${ev}/report/photos`)
          .set('Content-Type', 'image/png')
          .send(await png())
      ).status,
    ).toBe(401);
    expect((await photo(org.admin, ev, await png())).status).toBe(201);
  });

  it('removes a photograph and its file, and not one that belongs to another event', async () => {
    const ev = await published();
    const other = (await endedEvent(t, org, ['stayed'])).ev;
    const mine = (await photo(org.organizer, ev, await png())).body.data.id as string;
    const theirs = (await photo(org.organizer, other, await png())).body.data.id as string;
    expect(storedFiles()).toHaveLength(2);
    expect(
      (await as(t, org.organizer).delete(`/api/events/${ev}/report/photos/${theirs}`)).status,
    ).toBe(404);
    expect(
      (await as(t, org.organizer).delete(`/api/events/${ev}/report/photos/${mine}`)).status,
    ).toBe(200);
    expect(storedFiles()).toHaveLength(1);
    expect(await audit('report.photo_removed')).toHaveLength(1);
    expect(
      (await as(t, org.organizer).delete(`/api/events/${ev}/report/photos/${mine}`)).status,
    ).toBe(404);
  });

  it('is only possible once the event is published (not for an approved or cancelled one)', async () => {
    const { createApprovedEvent } = await import('./helpers.js');
    const approved = await createApprovedEvent(t, org);
    const res = await photo(org.organizer, approved, await png());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EVENT_NOT_ACTIVE');
    expect(storedFiles()).toHaveLength(0);
  });
});

describe('outcomes', () => {
  it('saves, replaces and clears the text, and audits it', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    const put = (who: LoggedIn, body: object) =>
      as(t, who).put(`/api/events/${ev}/report/outcomes`, body);
    expect(
      (await put(org.organizer, { outcomes: '  Six prototypes were built.  ' })).body.data,
    ).toEqual({ outcomes: 'Six prototypes were built.' });
    expect(
      (await as(t, org.faculty).get(`/api/events/${ev}/report`)).body.data.inputs.outcomes,
    ).toBe('Six prototypes were built.');
    expect((await put(org.admin, { outcomes: 'Updated by an admin.' })).status).toBe(200);
    expect((await put(org.organizer, { outcomes: '   ' })).body.data).toEqual({ outcomes: null });
    expect(await audit('report.outcomes_saved')).toHaveLength(3);
  });

  it('is for the organizer and admins, and validated', async () => {
    const { ev } = await endedEvent(t, org, ['stayed']);
    for (const who of [org.faculty, org.hod, org.student, org.otherOrganizer]) {
      expect(
        (await as(t, who).put(`/api/events/${ev}/report/outcomes`, { outcomes: 'x' })).status,
      ).toBe(403);
    }
    for (const bad of [
      {},
      { outcomes: 5 },
      { outcomes: 'x'.repeat(3001) },
      { outcomes: 'ok', extra: 1 },
    ]) {
      expect(
        (await as(t, org.organizer).put(`/api/events/${ev}/report/outcomes`, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    expect(
      (await request(t.app).put(`/api/events/${ev}/report/outcomes`).send({ outcomes: 'x' }))
        .status,
    ).toBe(401);
    await expect(
      q("INSERT INTO event_report_inputs (event_id, outcomes) VALUES ($1, '')", [ev]),
    ).rejects.toMatchObject({ constraint: 'event_report_outcomes_length' });
  });
});

describe('what the database guarantees', () => {
  it('keeps a version’s state consistent and allows one pending version at a time', async () => {
    const { ev, report } = await closed(['stayed']);
    await expect(
      q("UPDATE event_reports SET status = 'ready' WHERE id = $1", [report.id]),
    ).rejects.toMatchObject({ constraint: 'event_reports_ready_check' });
    await expect(
      q("UPDATE event_reports SET status = 'failed' WHERE id = $1", [report.id]),
    ).rejects.toMatchObject({ constraint: 'event_reports_failed_check' });
    await expect(
      q("INSERT INTO event_reports (event_id, version, reason) VALUES ($1, 2, 'manual')", [ev]),
    ).rejects.toMatchObject({ constraint: 'event_reports_one_pending_key' });
    await expect(
      q(
        "INSERT INTO event_reports (event_id, version, reason, status, error) VALUES ($1, 1, 'manual', 'failed', 'x')",
        [ev],
      ),
    ).rejects.toMatchObject({ constraint: 'event_reports_version_key' });
  });
});
