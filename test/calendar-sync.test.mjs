import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, plain } from './boot.mjs';
import { setClock, GasDate } from './fake-gas.mjs';

const TODAY = '2026-10-09';
const people = [
  { VolunteerID: 'V1', Name: 'Ann Lee', Credential: 'MD', Status: 'Active' },
  { VolunteerID: 'V2', Name: 'Emily Walls', Credential: 'NP', Status: 'Active' },
  { VolunteerID: 'V3', Name: 'Sam Walls', Credential: 'PA', Status: 'Active' },
  { VolunteerID: 'V4', Name: 'Rita Lee', Credential: 'RN', Status: 'Active' }
];
const opts = { from: TODAY, to: '2027-04-07', ignored: {} };
const row = (o) => Object.assign({ VolunteerID: 'V1', ReleasedAt: '', CalendarEventId: '', EventTitle: '', _row: Math.random() }, o);

test('reconcile: adds, deletes, moves, renames, conflicts and what needs a look', () => {
  const { app } = boot();
  const r = (events, shifts, o = opts) => plain(app.reconcileCalendar(events, shifts, people, o));

  let p = r([{ eventId: 'e1', title: 'Emily Walls', dates: ['2026-10-20'] }], []);
  assert.deepEqual(p.claims, [{ date: '2026-10-20', volunteerId: 'V2', eventId: 'e1', title: 'Emily Walls' }]);

  const linked = row({ ShiftDate: '2026-10-20', VolunteerID: 'V2', CalendarEventId: 'e1', EventTitle: 'Emily Walls' });
  assert.deepEqual(r([{ eventId: 'e1', title: 'Emily Walls', dates: ['2026-10-20'] }], [linked]),
    { releases: [], claims: [], retitles: [], flags: [] }, 'in step: nothing to do');
  p = r([], [linked]);
  assert.equal(p.releases[0].reason, 'removed from the calendar');
  p = r([{ eventId: 'e1', title: 'Emily Walls', dates: ['2026-10-22'] }], [linked]);
  assert.deepEqual([p.releases[0].reason, p.claims[0].date], ['moved on the calendar', '2026-10-22']);
  p = r([{ eventId: 'e1', title: 'Ann Lee', dates: ['2026-10-20'] }], [linked]);
  assert.deepEqual([p.releases[0].reason, p.claims[0].volunteerId], ['renamed on the calendar', 'V1']);
  p = r([{ eventId: 'e1', title: 'Emily Walls (swap w/ Sam)', dates: ['2026-10-20'] }], [linked]);
  assert.deepEqual([p.releases.length, p.retitles[0].title], [0, 'Emily Walls (swap w/ Sam)'], 'a note in the title keeps the day');

  p = r([{ eventId: 'e2', title: 'Dr. Walls', dates: ['2026-10-21'] }, { eventId: 'e3', title: 'Staff meeting', dates: ['2026-10-23'] },
    { eventId: 'e4', title: 'Rita Lee', dates: ['2026-10-24'] }], []);
  assert.deepEqual(p.flags.map((f) => f.problem), ['Matches more than one volunteer',
    'Doesn\'t name a volunteer who takes call', 'Doesn\'t name a volunteer who takes call']);
  assert.equal(r([{ eventId: 'e3', title: 'Staff meeting', dates: ['2026-10-23'] }], [], Object.assign({}, opts, { ignored: { e3: true } })).flags.length, 0);

  const assigned = row({ ShiftDate: '2026-10-21', VolunteerID: 'V2', CalendarEventId: 'e2', EventTitle: 'Dr. Walls' });
  assert.equal(r([{ eventId: 'e2', title: 'Dr. Walls', dates: ['2026-10-21'] }], [assigned]).flags.length, 0, 'an admin\'s pick sticks');

  const app1 = row({ ShiftDate: '2026-10-25', VolunteerID: 'V1', CalendarEventId: 'a1', EventTitle: 'HFJ on call: Ann Lee' });
  p = r([{ eventId: 'a1', title: 'HFJ on call: Ann Lee', dates: ['2026-10-25'] }, { eventId: 'e5', title: 'Sam Walls', dates: ['2026-10-25'] }], [app1]);
  assert.deepEqual([p.claims.length, p.flags[0].problem], [0, 'Someone else already has this day in the app']);

  const multi = { eventId: 'e6', title: 'Ann Lee', dates: ['2026-10-26', '2026-10-27'] };
  const day1 = row({ ShiftDate: '2026-10-26', CalendarEventId: 'e6', EventTitle: 'Ann Lee' });
  const gave = row({ ShiftDate: '2026-10-27', CalendarEventId: 'e6', EventTitle: 'Ann Lee', ReleasedAt: 'x', ReleasedBy: 'volunteer:V1' });
  assert.equal(r([multi], [day1, gave]).claims.length, 0, 'a day given up in the app isn\'t taken back from a two-day event');

  const past = row({ ShiftDate: '2026-10-01', CalendarEventId: 'old' });
  assert.equal(r([], [past]).releases.length, 0, 'history is left alone');
});

// ---------------------------------------------------------------- flows

function setup() {
  setClock(TODAY + 'T12:00:00Z');
  const ctx = boot({ today: TODAY });
  const { app, gas } = ctx;
  app.setupTabs();
  const ids = {};
  for (const [name, cred] of [['Ann Lee', 'MD'], ['Emily Walls', 'NP'], ['Sam Walls', 'PA'], ['Bo Diaz', 'PA']]) {
    ids[name] = app.api_createVolunteer({ Name: name, Email: name.split(' ')[0].toLowerCase() + '@example.com', Credential: cred, Status: 'Active' });
  }
  const cal = gas.makeCalendar('hfjcall@group.calendar.google.com', 'HFJ Call Schedule',
    { 'anthony@hfjvc.org': 'owner', 'volunteers@hfjvc.org': 'writer', 'emily@example.com': 'writer' });
  app.api_useCalendar(cal.id, '2026-10');
  // Someone editing the calendar directly in Google Calendar.
  const human = (title, date) => {
    const was = gas.state.effective;
    gas.state.effective = 'anthony@hfjvc.org';
    const ev = cal.createEvent(title, new GasDate(date + 'T17:00:00Z'), new GasDate(date + 'T23:00:00Z'));
    gas.state.effective = was;
    return ev;
  };
  const shifts = () => app.readRows_('CallShifts');
  const active = () => shifts().filter((s) => !s.ReleasedAt).map((s) => [s.ShiftDate, s.VolunteerID, s.Source]);
  return Object.assign(ctx, { cal, ids, human, shifts, active });
}

test('calendar → app: a day added, moved, renamed or deleted on Google Calendar shows up in the app', () => {
  const { app, gas, cal, ids, human, active } = setup();
  const ev = human('Emily Walls', '2026-10-20');
  const before = gas.sent.length;
  app.calendarSync();
  assert.deepEqual(plain(active()), [['2026-10-20', ids['Emily Walls'], 'calendar']]);
  assert.equal(app.readRows_('CallShifts')[0].CalendarEventId, ev.id);
  assert.equal(cal.events.filter((e) => !e.deleted).length, 1, 'linked, nothing added');
  assert.ok(gas.sent.slice(before).some((m) => /Emily Walls is on the calendar for 2026-10-20 but isn't eligible/.test(m.subject)), 'warn-only: admins told');

  ev.start = new GasDate('2026-10-22T17:00:00Z'); ev.end = new GasDate('2026-10-23T17:00:00Z');
  app.calendarSync();
  assert.deepEqual(plain(active()), [['2026-10-22', ids['Emily Walls'], 'calendar']], 'moved');

  ev.title = 'Bo Diaz';
  app.calendarSync();
  assert.deepEqual(plain(active()), [['2026-10-22', ids['Bo Diaz'], 'calendar']], 'renamed to someone else');

  ev.deleted = true;
  app.calendarSync();
  assert.deepEqual(plain(active()), [], 'deleted');
  const rel = app.readRows_('CallShifts').pop();
  assert.equal(rel.ReleasedBy, 'calendar');
  assert.ok(app.readRows_('AuditLog').some((a) => a.Actor === 'calendar' && /removed from the calendar/.test(a.Details)));
});

test('app → calendar still works, and the two directions don\'t echo', () => {
  const { app, cal, ids, active } = setup();
  app.api_assignShift('2026-10-25', ids['Ann Lee'], '2026-10');
  assert.equal(cal.events.filter((e) => !e.deleted).length, 1);
  app.calendarSync();
  app.calendarSync();
  assert.deepEqual(plain(active()), [['2026-10-25', ids['Ann Lee'], 'admin']]);
  assert.equal(cal.events.filter((e) => !e.deleted).length, 1, 'no duplicate either way');
  app.api_unassignShift('2026-10-25', '2026-10');
  app.calendarSync();
  assert.deepEqual(plain(active()), []);
});

test('needs a look: ambiguous names and non-call events are flagged once, then assigned or ignored', () => {
  const { app, gas, ids, human, active } = setup();
  const walls = human('Dr. Walls', '2026-10-21');
  human('Staff meeting', '2026-10-23');
  const n = gas.sent.length;
  app.calendarSync();
  let cal = plain(app.api_calendar('2026-10'));
  assert.deepEqual(cal.review.flags.map((f) => f.title).sort(), ['Dr. Walls', 'Staff meeting']);
  assert.equal(gas.sent.slice(n).filter((m) => /2 events need a look/.test(m.subject)).length, 1);
  app.calendarSync();
  assert.equal(gas.sent.filter((m) => /need a look/.test(m.subject)).length, 1, 'told once');

  cal = plain(app.api_resolveCalendarEvent(walls.id, ids['Emily Walls'], '2026-10'));
  assert.deepEqual(plain(active()), [['2026-10-21', ids['Emily Walls'], 'calendar']]);
  assert.deepEqual(cal.review.flags.map((f) => f.title), ['Staff meeting']);
  const meeting = cal.review.flags[0].eventId;
  cal = plain(app.api_ignoreCalendarEvent(meeting, '2026-10'));
  assert.equal(cal.review.flags.length, 0);
  app.calendarSync();
  assert.equal(plain(app.api_calendar('2026-10')).review.flags.length, 0, 'stays ignored; the pick for Dr. Walls sticks');
  assert.deepEqual(plain(active()), [['2026-10-21', ids['Emily Walls'], 'calendar']]);
});

test('a calendar event on a day someone already has in the app is flagged, not overwritten', () => {
  const { app, ids, human, active } = setup();
  app.api_assignShift('2026-10-25', ids['Ann Lee'], '2026-10');
  human('Sam Walls', '2026-10-25');
  app.calendarSync();
  assert.deepEqual(plain(active()), [['2026-10-25', ids['Ann Lee'], 'admin']]);
  assert.match(plain(app.api_calendar('2026-10')).review.flags[0].problem, /already has this day/);
});

test('a calendar that suddenly looks empty pauses the sync instead of releasing everyone', () => {
  const { app, gas, cal, human, active } = setup();
  for (let d = 12; d <= 18; d++) human(['Ann Lee', 'Sam Walls', 'Bo Diaz'][d % 3], '2026-10-' + d);
  app.calendarSync();
  assert.equal(active().length, 7);
  cal.events.forEach((e) => { e.deleted = true; });
  app.calendarSync();
  assert.equal(active().length, 7, 'nothing released');
  assert.ok(gas.sent.some((m) => /Calendar sync paused: 7 call days missing/.test(m.subject)));
});

test('volunteers see calendar changes when they open their calendar; the trigger and admins can run the sync, the portal can\'t', () => {
  const { app, gas, ids, human } = setup();
  app.api_bulkInvite('Ann Lee, ann@example.com, MD', 'Active');
  const token = gas.sent.filter((m) => m.to === 'ann@example.com').pop().body.match(/[?]t=([a-f0-9]{64})/)[1];
  human('Ann Lee', '2026-10-27');
  setClock(TODAY + 'T12:05:00Z');
  const view = plain(app.portal_calendar(token, '2026-10'));
  assert.equal(view.days.find((d) => d.date === '2026-10-27').status, 'mine');
  void ids;

  gas.state.user = '';
  assert.throws(() => app.calendarSync(), /Sign in/);
  gas.state.triggers = ['777'];
  app.calendarSync({ triggerUid: '777' });
  setClock(TODAY);
});
