import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A process that changes an event's state without the hooks silently skips the report, the booking
// release and the registration rules. Found once: the worker closed events without queueing reports.
describe('event hooks are registered in every process that changes events', () => {
  const source = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

  it.each(['app.ts', 'worker.ts'])('%s calls registerEventHooks', (file) => {
    expect(source(file)).toMatch(/registerEventHooks\(ctx\);/);
  });

  it('registerEventHooks covers every feature that listens to the lifecycle', () => {
    const body = source('hooks.ts');
    for (const name of [
      'registerBookingHooks',
      'registerRegistrationHooks',
      'registerAttendanceGuards',
      'registerReportHooks',
    ]) {
      expect(body).toContain(`${name}(`);
    }
  });

  it('every module that registers an event hook is listed there', () => {
    const files = execSync("grep -rl 'registerEventHook(' src --include=hooks.ts || true", {
      cwd: new URL('..', import.meta.url).pathname,
    })
      .toString()
      .trim()
      .split('\n')
      .filter((f) => f && f !== 'src/modules/events/hooks.ts');
    const body = source('hooks.ts');
    for (const f of files) {
      const dir = f.split('/')[2]!;
      expect(
        body,
        `${dir} registers an event hook but registerEventHooks does not call it`,
      ).toContain(`./modules/${dir}/hooks.js`);
    }
  });
});
