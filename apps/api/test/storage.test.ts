import express from 'express';
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import {
  detectKind,
  LocalFileStorage,
  safeDownloadName,
  sendStoredFile,
} from '../src/platform/storage/index.js';

const root = mkdtempSync(path.join(tmpdir(), 'storage-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const storage = new LocalFileStorage(root);

const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('fake body')]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('x'),
]);
const html = Buffer.from('<script>alert(1)</script>');
const opts = { allowed: ['pdf' as const], maxBytes: 1024 };

describe('LocalFileStorage', () => {
  it('stores a PDF under a generated key and reads it back', async () => {
    const stored = await storage.put({ data: pdf, ...opts });
    expect(stored).toMatchObject({ contentType: 'application/pdf', size: pdf.length });
    expect(stored.key).toMatch(/^[0-9a-f]{2}\/[0-9a-f-]{36}\.pdf$/);
    const back = await storage.get(stored.key);
    expect(back.data.equals(pdf)).toBe(true);
    expect(back.contentType).toBe('application/pdf');
  });

  it('identifies files by content, not by claimed name or type', async () => {
    expect(detectKind(pdf)).toBe('pdf');
    expect(detectKind(png)).toBe('png');
    expect(detectKind(html)).toBeNull();
    await expect(storage.put({ data: html, ...opts })).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
  });

  it('rejects types that are not allowed for this use, empty files and oversized files', async () => {
    await expect(storage.put({ data: png, ...opts })).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
    await expect(storage.put({ data: Buffer.alloc(0), ...opts })).rejects.toMatchObject({
      code: 'INVALID_FILE',
    });
    await expect(
      storage.put({ data: Buffer.concat([pdf, Buffer.alloc(2000)]), ...opts }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    expect(
      (await storage.put({ data: png, allowed: ['pdf', 'png'], maxBytes: 1024 })).contentType,
    ).toBe('image/png');
  });

  it('never writes outside the storage root, whatever key is supplied', async () => {
    const outside = path.join(root, '..', 'outside-secret.txt');
    writeFileSync(outside, 'secret');
    try {
      for (const key of [
        '../outside-secret.txt',
        '/etc/passwd',
        'ab/../../outside-secret.txt',
        'ab/x.pdf',
        '',
        'aa/00000000-0000-0000-0000-000000000000.exe',
        'aa\\..\\x',
      ]) {
        await expect(storage.get(key), key).rejects.toMatchObject({ code: 'INVALID_FILE_KEY' });
        await expect(storage.remove(key), key).rejects.toMatchObject({ code: 'INVALID_FILE_KEY' });
      }
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('returns 404 for a well-formed key that does not exist, and deletes files', async () => {
    await expect(storage.get('aa/00000000-0000-4000-8000-000000000000.pdf')).rejects.toMatchObject({
      status: 404,
    });
    const stored = await storage.put({ data: pdf, ...opts });
    await storage.remove(stored.key);
    await expect(storage.get(stored.key)).rejects.toMatchObject({ status: 404 });
    expect(readdirSync(root).length).toBeGreaterThan(0);
  });
});

describe('safeDownloadName', () => {
  it('strips path separators, quotes and header-breaking characters', () => {
    expect(safeDownloadName('../../etc/passwd')).toBe('_.._etc_passwd'); // no separators survive
    expect(safeDownloadName('a"b\r\nSet-Cookie: x=1.pdf')).not.toMatch(/["\r\n]/);
    expect(safeDownloadName('   ')).toBe('download');
    expect(safeDownloadName('Event Report 2026.pdf')).toBe('Event Report 2026.pdf');
  });
});

describe('sendStoredFile', () => {
  it('forces download and disables sniffing and shared caching', async () => {
    const stored = await storage.put({ data: pdf, ...opts });
    const app = express();
    app.get('/f', async (_req, res) =>
      sendStoredFile(res, storage, stored.key, 'Report "final".pdf'),
    );
    const res = await request(app).get('/f');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="Report _final_.pdf"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});
