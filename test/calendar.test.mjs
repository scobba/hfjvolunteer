import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, plain } from './boot.mjs';
import { setClock, GasDate } from './fake-gas.mjs';

const TODAY = '2026-10-09';
const tokenFrom = (mail) => mail.body.match(/[?]t=([a-f0-9]{64})/)[1];

function setup() {
  setClock(TODAY);
  const ctx = boot({ today: TODAY });
  ctx.app.setupTabs();
  return ctx;
}

function invite(ctx, line, status = 'Active') {
  ctx.app.api_bulkInvite(line, status);
  const email = line.split(',')[1].trim().toLowerCase();
  return tokenFrom(ctx.gas.sent.filter((m) => m.to === email).pop());
}

const hfjCal = (gas) => Object.values(gas.calendars).find((c) => c.name === 'HFJ On Call');

// ---------------------------------------------------------------- pure

test('who takes call, and what a volunteer may claim', () => {
  const { app } = setup();
  assert.ok(app.takesCall({ Credential: 'MD' }) && app.takesCall({ Credential: 'NP' }) && app.takesCall({ Credential: 'PA' }));
  assert.ok(!app.takesCall({ Credential: 'RN' }) && !app.takesCall({ Credential: 'LMFT' }) && !app.takesCall({ Credential: 'AMFT' }));
  const v = { VolunteerID: 'V1', Name: 'Ann', Credential: 'MD', Status: 'Active' };
  const opts = { today: TODAY, horizonDays: 180 };
  assert.equal(app.claimProblem(v, '2026-10-20', {}, opts), '');
  assert.match(app.claimProblem(v, '2026-10-08', {}, opts), /passed/);
  assert.match(app.claimProblem(v, '2027-04-08', {}, opts), /180 days/);
  assert.match(app.claimProblem(v, '2026-10-20', { '2026-10-20': { VolunteerID: 'V2' } }, opts), /already taken/);
  assert.match(app.claimProblem(Object.assign({}, v, { Status: 'Prospective' }), '2026-10-20', {}, opts), /activated/);
  assert.equal(app.claimProblem(Object.assign({}, v, { Status: 'Prospective' }), '2026-01-01', {}, Object.assign({ byAdmin: true }, opts)), '');
  assert.equal(app.monthDates('2026-02').length, 28);
  assert.ok(app.isMonth('2026-10') && !app.isMonth('2026-13'));

  const shifts = [{ ShiftDate: '2026-10-20', VolunteerID: 'V1' }, { ShiftDate: '2026-10-21', VolunteerID: 'V2' },
    { ShiftDate: '2026-10-22', VolunteerID: 'V1', ReleasedAt: 'x' }];
  const m = plain(app.portalMonth(v, shifts, '2026-10', opts));
  const at = (d) => m.days.find((x) => x.date === d).status;
  assert.deepEqual([at('2026-10-01'), at('2026-10-20'), at('2026-10-21'), at('2026-10-22')], ['past', 'mine', 'taken', 'open']);
  assert.equal(m.count, 1);
  assert.ok(!JSON.stringify(m).includes('V2'), 'other volunteers are never identified');
});

test('importing: names in event titles are matched to volunteers who take call', () => {
  const { app } = setup();
  const people = [
    { VolunteerID: 'V1', Name: 'Ann Lee', Credential: 'MD', Status: 'Active' },
    { VolunteerID: 'V2', Name: 'Emily Walls', Credential: 'NP', Status: 'Active' },
    { VolunteerID: 'V3', Name: 'Sam Walls', Credential: 'PA', Status: 'Active' },
    { VolunteerID: 'V4', Name: 'Rita Lee', Credential: 'RN', Status: 'Active' }
  ];
  const rows = plain(app.matchImportEvents([
    { date: '2026-10-20', title: 'Dr. Lee on call' }, { date: '2026-10-21', title: 'Walls' },
    { date: '2026-10-22', title: 'Emily Walls' }, { date: '2026-10-23', title: 'Call' }, { date: '2026-10-24', title: 'Ann Lee' }
  ], people, { '2026-10-24': { VolunteerID: 'V1' } }));
  assert.deepEqual(rows.map((r) => r.volunteerId), ['V1', '', 'V2', '', 'V1']);
  assert.match(rows[1].note, /more than one/);
  assert.match(rows[3].note, /No name/);
  assert.ok(rows[4].skip, 'already claimed');
});

// ---------------------------------------------------------------- flows

test('a physician claims and releases days from their link; the calendar event follows', () => {
  const ctx = setup();
  const { app, gas } = ctx;
  const token = invite(ctx, 'Ann Lee, ann@example.com, MD');
  assert.equal(plain(app.portal_bootstrap(token).calendar).open, true);

  let view = plain(app.portal_calendar(token, '2026-10'));
  assert.equal(view.days.find((d) => d.date === '2026-10-20').status, 'open');
  assert.equal(view.eligible, false);

  const before = gas.sent.length;
  view = plain(app.portal_claim(token, '2026-10-20', '2026-10'));
  assert.match(view.warning, /license/i, 'warn-only: claim stands, with what is missing');
  assert.ok(gas.sent.slice(before).some((m) => /claimed 2026-10-20 but isn't eligible/.test(m.subject)), 'admins told');
  assert.equal(view.days.find((d) => d.date === '2026-10-20').status, 'mine');
  assert.deepEqual(view.upcoming, ['2026-10-20']);

  const cal = hfjCal(gas);
  assert.ok(cal, 'HFJ On Call calendar created on first use');
  assert.equal(app.getSettings_().CallCalendarId, cal.id);
  const ev = cal.events[0];
  assert.equal(ev.title, 'HFJ on call: Ann Lee');
  assert.equal(ev.start.toISOString(), '2026-10-20T17:00:00.000Z');
  assert.equal(ev.end.toISOString(), '2026-10-21T17:00:00.000Z');
  assert.deepEqual([ev.opts.guests, ev.opts.sendInvites], ['ann@example.com', true]);
  assert.equal(app.readRows_('CallShifts')[0].CalendarEventId, ev.id);

  assert.throws(() => app.portal_claim(token, '2026-10-20', '2026-10'), /already have/);
  const other = invite(ctx, 'Bo Diaz, bo@example.com, PA');
  assert.throws(() => app.portal_claim(other, '2026-10-20', '2026-10'), /already taken/);
  assert.equal(plain(app.portal_calendar(other, '2026-10')).days.find((d) => d.date === '2026-10-20').status, 'taken');

  // Far ahead: no alert. Inside LateReleaseDays: admins hear at once.
  app.portal_claim(token, '2026-12-01', '2026-12');
  let n = gas.sent.length;
  app.portal_release(token, '2026-12-01', '2026-12');
  assert.equal(gas.sent.length, n);
  n = gas.sent.length;
  assert.throws(() => app.portal_release(token, '2026-10-12', '2026-10'), /don't have/);
  app.portal_claim(token, '2026-10-12', '2026-10');
  app.portal_release(token, '2026-10-12', '2026-10');
  assert.ok(gas.sent.slice(n).some((m) => /Call day open again: 2026-10-12/.test(m.subject)));
  assert.ok(cal.events.filter((e) => e.title === 'HFJ on call: Ann Lee' && e.deleted).length >= 2, 'released days leave the calendar');
  const rows = app.readRows_('CallShifts');
  assert.ok(rows.every((r) => r.ClaimedBy === 'volunteer:HFJV-00001' && r.Source === 'portal'));
  assert.ok(app.readRows_('AuditLog').some((a) => a.Action === 'shift.release'));
});

test('timing: today\'s shift can be claimed until it starts; a started shift can\'t be released', () => {
  const ctx = setup();
  const { app } = ctx;
  const token = invite(ctx, 'Ann Lee, ann@example.com, MD');
  setClock('2026-10-09T16:59:00Z');
  app.portal_claim(token, '2026-10-09', '2026-10');
  setClock('2026-10-09T17:00:00Z');
  assert.throws(() => app.portal_release(token, '2026-10-09', '2026-10'), /already started/);
  setClock('2026-10-10T17:30:00Z');
  assert.throws(() => app.portal_claim(token, '2026-10-10', '2026-10'), /already started/);
  assert.throws(() => app.portal_claim(token, '2027-05-01', '2027-05'), /180 days/);
  setClock(TODAY);
});

test('who can\'t claim: non-LIPs, people not yet active, and anyone ineligible once blocking is on', () => {
  const ctx = setup();
  const { app } = ctx;
  const rn = invite(ctx, 'Rita Lee, rita@example.com, RN');
  assert.equal(app.portal_bootstrap(rn).calendar, null);
  assert.throws(() => app.portal_calendar(rn, '2026-10'), /physicians, NPs and PAs/);
  const pro = invite(ctx, 'Pat Kim, pat@example.com, NP', 'Prospective');
  assert.equal(plain(app.portal_bootstrap(pro).calendar).open, false);
  assert.throws(() => app.portal_claim(pro, '2026-10-20', '2026-10'), /activated/);
  const md = invite(ctx, 'Ann Lee, ann@example.com, MD');
  app.setSetting_('BlockIneligibleClaims', 'TRUE');
  assert.equal(plain(app.portal_calendar(md, '2026-10')).blocked, true);
  assert.throws(() => app.portal_claim(md, '2026-10-20', '2026-10'), /can't take call on 2026-10-20 yet/);
  assert.equal(app.readRows_('CallShifts').length, 0);
});

test('admins assign and clear days, see counts against targets, and failed syncs are retried', () => {
  const ctx = setup();
  const { app, gas } = ctx;
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active', CallTargetPerMonth: '2' });
  let cal = plain(app.api_assignShift('2026-10-15', id, '2026-10'));
  assert.equal(cal.days.find((d) => d.date === '2026-10-15').name, 'Ann Lee');
  assert.deepEqual(cal.people.map((p) => [p.name, p.count, p.target]), [['Ann Lee', 1, 2]]);
  assert.ok(cal.calendarUrl.includes(encodeURIComponent(app.getSettings_().CallCalendarId)));
  assert.equal(app.readRows_('CallShifts')[0].Source, 'admin');
  cal = plain(app.api_assignShift('2026-10-01', id, '2026-10'));
  assert.ok(cal.days.find((d) => d.date === '2026-10-01').past, 'admins can record past days');

  cal = plain(app.api_unassignShift('2026-10-15', '2026-10'));
  assert.equal(cal.days.find((d) => d.date === '2026-10-15').volunteerId, '');

  const hfj = hfjCal(gas);
  const real = hfj.createEvent;
  hfj.createEvent = () => { throw new Error('Calendar is down'); };
  app.api_assignShift('2026-10-16', id, '2026-10');
  assert.equal(app.readRows_('CallShifts').pop().CalendarEventId, '', 'claim stands without the event');
  assert.ok(app.readRows_('AuditLog').some((a) => a.Action === 'calendar.error'));
  hfj.createEvent = real;
  cal = plain(app.api_syncCalendar('2026-10'));
  assert.ok(cal.days.find((d) => d.date === '2026-10-16').synced);
});

test('daily job: on-call-tomorrow reminder and coverage gap alerts, each once', () => {
  const ctx = setup();
  const { app, gas } = ctx;
  app.dailyJob();
  assert.ok(!gas.sent.some((m) => /Call coverage/.test(m.subject)), 'no alerts before the calendar is in use');
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  app.api_assignShift('2026-10-10', id, '2026-10');
  app.dailyJob();
  const remind = gas.sent.filter((m) => m.to === 'ann@example.com' && /on call tomorrow, 2026-10-10/.test(m.subject));
  assert.equal(remind.length, 1);
  assert.match(remind[0].body, /from 17:00 tomorrow/);
  const gaps = gas.sent.filter((m) => /Call coverage: 13 open days in the next 14 days/.test(m.subject));
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].body, /- 2026-10-09 \(new\)/);
  app.dailyJob();
  assert.equal(gas.sent.filter((m) => /on call tomorrow/.test(m.subject)).length, 1);
  assert.equal(gas.sent.filter((m) => /Call coverage/.test(m.subject)).length, 1, 'same gaps are not re-alerted');
  setClock('2026-10-10');
  app.dailyJob();
  const later = gas.sent.filter((m) => /Call coverage/.test(m.subject));
  assert.equal(later.length, 2, 'a new day entering the window alerts');
  assert.match(later[1].body, /- 2026-10-23 \(new\)/);
  setClock(TODAY);
});

test('import from an existing call calendar: preview matches names, import saves claims without invitations', () => {
  const ctx = setup();
  const { app, gas } = ctx;
  const ann = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  const bo = app.api_createVolunteer({ Name: 'Bo Diaz', Email: 'bo@example.com', Credential: 'PA', Status: 'Active' });
  const old = gas.makeCalendar('oldcall@group.calendar.google.com', 'Old call schedule');
  old.createEvent('Lee on call', new GasDate('2026-10-12T17:00:00Z'), new GasDate('2026-10-13T17:00:00Z'));
  old.events.push({ title: 'Bo Diaz', deleted: false, start: new GasDate('2026-10-14T00:00:00Z'), end: new GasDate('2026-10-16T00:00:00Z'),
    getTitle() { return this.title; }, isAllDayEvent: () => true,
    getAllDayStartDate() { return this.start; }, getAllDayEndDate() { return this.end; } });
  old.createEvent('Staff meeting', new GasDate('2026-10-20T17:00:00Z'), new GasDate('2026-10-20T18:00:00Z'));

  assert.throws(() => app.api_importPreview('nope@group.calendar.google.com', TODAY, '2026-12-31'), /Share it with/);
  const prev = plain(app.api_importPreview(old.id, TODAY, '2026-12-31'));
  assert.deepEqual(prev.rows.map((r) => [r.date, r.volunteerId]),
    [['2026-10-12', ann], ['2026-10-14', bo], ['2026-10-15', bo], ['2026-10-20', '']]);
  assert.equal(app.readRows_('CallShifts').length, 0, 'preview saves nothing');

  const res = plain(app.api_importShifts(prev.rows.concat([{ date: '2026-10-12', volunteerId: bo }]), false));
  assert.equal(res.imported, 3);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0], /already taken/);
  const evs = hfjCal(gas).events;
  assert.equal(evs.length, 3);
  assert.ok(evs.every((e) => !e.opts.guests), 'no invitations unless asked');
  assert.ok(app.readRows_('CallShifts').every((r) => r.Source === 'import'));
});

test('the dashboard coverage block goes live with the calendar', () => {
  const ctx = setup();
  const { app } = ctx;
  assert.equal(plain(app.api_dashboard()).coverage.live, false);
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  app.api_assignShift('2026-10-09', id, '2026-10');
  const c = plain(app.api_dashboard()).coverage;
  assert.equal(c.live, true);
  assert.equal(c.gaps.length, 13);
});

test('authorizeCalendar runs only for the account itself, and never creates a calendar', () => {
  const ctx = setup();
  const { app, gas } = ctx;
  assert.throws(() => app.authorizeCalendar(), /editor/, 'an admin (or a portal visitor) calling it is refused');
  gas.state.user = 'volunteers@hfjvc.org';
  assert.match(app.authorizeCalendar(), /approved for volunteers@hfjvc.org/);
  assert.equal(Object.keys(gas.calendars).length, 0);
  gas.state.user = 'anthony@hfjvc.org';
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  app.api_assignShift('2026-10-20', id, '2026-10');
  gas.state.user = 'volunteers@hfjvc.org';
  assert.match(app.authorizeCalendar(), /HFJ On Call calendar: cal1/);
});

test('run as an admin from the Sheet menu, the daily job leaves the calendar alone', () => {
  const ctx = setup();
  const { app, gas } = ctx;
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  app.api_assignShift('2026-10-20', id, '2026-10'); // web app: runs as volunteers@, creates HFJ On Call
  const hfj = hfjCal(gas);
  hfj.createEvent = () => { throw new Error('down'); };
  app.api_assignShift('2026-10-21', id, '2026-10');
  const calId = app.getSettings_().CallCalendarId;
  gas.state.effective = 'anthony@hfjvc.org'; // menu run: the script runs as the admin who clicked
  app.dailyJob();
  assert.equal(Object.keys(gas.calendars).length, 1, 'no second calendar');
  assert.equal(app.getSettings_().CallCalendarId, calId);
  assert.equal(app.readRows_('CallShifts').pop().CalendarEventId, '', 'left for the owner to sync');
  assert.throws(() => app.ensureCallCalendar_(), /belongs to another account/);
});
