import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot } from './boot.mjs';

// Every top-level function without a trailing _ can be called from a page with
// google.script.run, including the public volunteer portal, where the script
// runs as volunteers@ for an anonymous visitor (no active user).

const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

/** Public functions that only compute and return a value from their arguments. */
const PURE_FILES = ['Dates', 'Config', 'Matrix', 'Eligibility', 'Dashboard', 'Reminders', 'Calendar', 'Documents',
  'Render', 'Uploads', 'Onboarding'];
const PURE_ELSEWHERE = ['parseInviteList', 'assertAllowedShare', 'bytesToHex', 'isTokenShaped',
  // Migration's parse half
  'normalizeHeader', 'mapHeader', 'categoryForTab', 'isDateCell', 'cellText', 'parseBool', 'normalizePhone',
  'parseCallTarget', 'parseCredential', 'parseStatus', 'parseSourceTab', 'addRequirementCell',
  'resolveRequirementKeys', 'mergeRecords', 'migrationSourceTabNames'];
/** Entry points with side effects, each guarded (see the test below). */
const GUARDED = ['dailyJob', 'setupTabs', 'installTriggers', 'migrationDryRun', 'migrationCommit',
  'menuMigrationDryRun', 'menuMigrationCommit', 'authorizeCalendar'];
const PLATFORM = ['doGet', 'include', 'onOpen'];

test('source: every public server function is pure, token-checked, admin-checked or guarded', () => {
  const unexpected = [];
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.gs'))) {
    const body = fs.readFileSync(path.join(src, f), 'utf8');
    for (const m of body.matchAll(/^function ([A-Za-z0-9]+[^_\W])\s*\(/gm)) {
      const name = m[1];
      if (PURE_FILES.includes(f.replace('.gs', '')) || PURE_ELSEWHERE.includes(name) || GUARDED.includes(name) || PLATFORM.includes(name)) continue;
      if (/^(portal|supervisor)_/.test(name)) continue;
      if (/^api_/.test(name)) {
        const fn = body.slice(m.index).split(/\n}\n/)[0];
        if (!/requireAdmin_\(\)/.test(fn)) unexpected.push(f + ': ' + name + ' does not call requireAdmin_()');
        continue;
      }
      unexpected.push(f + ': ' + name);
    }
  }
  assert.deepEqual(unexpected, [], 'Name new server-only functions with a trailing _, or guard them and list them in GUARDED.');
});

test('an anonymous caller (the public portal) is refused by every guarded entry point', () => {
  const { app, gas } = boot();
  app.setupTabs(); // first run, by the admin who sets the Sheet up
  gas.state.user = '';
  for (const name of GUARDED) {
    assert.throws(() => app[name](), /./, name);
  }
  assert.throws(() => app.dailyJob({ triggerUid: '12345' }), /Sign in/, 'claiming to be a trigger does not work');
  const before = gas.sent.length;
  assert.equal(app.readRows_('AuditLog').filter((a) => a.Action === 'setup.tabs').length, 1, 'setupTabs did not run again');
  assert.equal(gas.sent.length, before);
});

test('the daily job runs for its real trigger, the account itself, or an admin; not other signed-in users', () => {
  const { app, gas } = boot();
  app.setupTabs();
  gas.state.user = '';
  gas.state.triggers = ['8812345678901234567'];
  app.dailyJob({ triggerUid: '8812345678901234567' });
  gas.state.user = 'volunteers@hfjvc.org';
  app.dailyJob();
  gas.state.user = 'anthony@hfjvc.org';
  app.dailyJob();
  gas.state.user = 'someone@hfjvc.org';
  assert.throws(() => app.dailyJob(), /not on the Admins list/);
  gas.state.user = 'visitor@gmail.com';
  assert.throws(() => app.dailyJob(), /not an @hfjvc.org account/);
});
