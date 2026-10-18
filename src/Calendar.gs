/**
 * The call calendar (spec §7, Phase 3). Pure: rules and planning only;
 * CallShifts.gs does the writing and the Google Calendar sync.
 *
 * One LIP on call per 24-hour day, starting at Settings.ShiftStartTime on the
 * ShiftDate. Self-serve: claim and done. A CallShifts row is one claim; a
 * release stamps ReleasedAt, so the history stays.
 */

/** Credential groups that take call. */
var CALL_GROUPS = ['MD_DO', 'NP_PA'];

function takesCall(v) {
  var info = credentialInfo(v.Credential);
  return !!info && CALL_GROUPS.indexOf(info.group) !== -1;
}

/** Current claims by date: { 'yyyy-MM-dd': row }. */
function activeShiftsByDate(shifts) {
  var out = {};
  shifts.forEach(function (s) {
    if (s.VolunteerID && !s.ReleasedAt && isIsoDate(s.ShiftDate)) out[s.ShiftDate] = s;
  });
  return out;
}

/** Days claimed per volunteer in a month ('yyyy-MM'): { VolunteerID: n }. */
function monthCounts(shifts, month) {
  var out = {};
  shifts.forEach(function (s) {
    if (!s.VolunteerID || s.ReleasedAt || String(s.ShiftDate).slice(0, 7) !== month) return;
    out[s.VolunteerID] = (out[s.VolunteerID] || 0) + 1;
  });
  return out;
}

/** Every date of a month, in order. */
function monthDates(month) {
  var out = [];
  for (var d = month + '-01'; d.slice(0, 7) === month; d = addDays(d, 1)) out.push(d);
  return out;
}

function isMonth(s) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || ''));
}

/**
 * Why `v` can't claim `date`, or '' if they can. Doesn't check the time of day
 * (whether today's shift has started); CallShifts.gs does.
 * opts: { today, horizonDays, byAdmin }  byAdmin allows past dates and any status.
 */
function claimProblem(v, date, byDate, opts) {
  if (!isIsoDate(date)) return 'Choose a date.';
  if (!takesCall(v)) return 'Only physicians, NPs and PAs take HFJ call.';
  if (!opts.byAdmin && v.Status !== 'Active') return 'Call opens once HFJ has activated you.';
  if (v.Status === 'Departed' || v.Status === 'Inactive') return v.Name + ' is ' + v.Status + '.';
  if (!opts.byAdmin && date < opts.today) return 'That day has passed.';
  if (!opts.byAdmin && date > addDays(opts.today, opts.horizonDays)) return 'The calendar is open ' + opts.horizonDays + ' days ahead.';
  var taken = byDate[date];
  if (taken) return taken.VolunteerID === v.VolunteerID ? 'You already have ' + date + '.' : date + ' is already taken.';
  return '';
}

/**
 * A volunteer's view of one month: their days, open days and taken days.
 * Other volunteers are never named here.
 */
function portalMonth(v, shifts, month, opts) {
  var byDate = activeShiftsByDate(shifts);
  var horizonEnd = addDays(opts.today, opts.horizonDays);
  var days = monthDates(month).map(function (d) {
    var s = byDate[d];
    var status = s ? (s.VolunteerID === v.VolunteerID ? 'mine' : 'taken')
      : d < opts.today ? 'past' : d > horizonEnd ? 'later' : 'open';
    return { date: d, status: status };
  });
  return {
    month: month, days: days,
    count: monthCounts(shifts, month)[v.VolunteerID] || 0,
    target: v.CallTargetPerMonth === '' || v.CallTargetPerMonth === undefined ? '' : v.CallTargetPerMonth,
    upcoming: Object.keys(byDate).filter(function (d) { return d >= opts.today && byDate[d].VolunteerID === v.VolunteerID; }).sort(),
    horizonEnd: horizonEnd
  };
}

/** The admin view of one month: who has each day, and each LIP's count against target. */
function adminMonth(volunteers, shifts, month, today) {
  var byDate = activeShiftsByDate(shifts);
  var names = {};
  volunteers.forEach(function (v) { names[v.VolunteerID] = v.PreferredName || v.Name; });
  var counts = monthCounts(shifts, month);
  return {
    month: month,
    days: monthDates(month).map(function (d) {
      var s = byDate[d];
      return { date: d, past: d < today, volunteerId: s ? s.VolunteerID : '', name: s ? names[s.VolunteerID] || s.VolunteerID : '',
        synced: s ? !!s.CalendarEventId : false };
    }),
    people: volunteers.filter(function (v) { return takesCall(v) && v.Status === 'Active'; })
      .map(function (v) { return { volunteerId: v.VolunteerID, name: v.Name, count: counts[v.VolunteerID] || 0, target: v.CallTargetPerMonth }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : 1; }),
    open: monthDates(month).filter(function (d) { return d >= today && !byDate[d]; }).length
  };
}

/**
 * Daily call reminders: "on call tomorrow" to the volunteer, and uncovered
 * days in the next `gapDays` to admins (each date once, all in one email).
 * Gap alerts start once the calendar has any claim, so an empty calendar
 * before go-live doesn't alert.
 * opts: { gapDays, onCallReminders, gapAlerts, startTime }
 */
function planCallReminders(volunteers, shifts, today, opts, log) {
  var out = [];
  var byId = {};
  volunteers.forEach(function (v) { byId[v.VolunteerID] = v; });
  var byDate = activeShiftsByDate(shifts);
  var tomorrow = addDays(today, 1);
  var s = byDate[tomorrow];
  var v = s && byId[s.VolunteerID];
  if (opts.onCallReminders && v && v.Email && CURRENT_STATUSES.indexOf(v.Status) !== -1) {
    var key = 'oncall|' + tomorrow + '|' + v.VolunteerID;
    if (!log[key]) {
      out.push({ key: key, kind: 'oncall', volunteerId: v.VolunteerID, to: v.Email,
        subject: 'HFJ: you\'re on call tomorrow, ' + tomorrow,
        body: 'Hi ' + String(v.PreferredName || v.Name).split(' ')[0] + ',\n\nA reminder that you\'re on call for HFJ ' +
          'from ' + opts.startTime + ' tomorrow (' + tomorrow + ') for 24 hours.\n\nIf you can no longer cover it, release the day ' +
          'from your personal HFJ link as soon as you can, or let HFJ know.\n\nThank you.' });
    }
  }
  if (opts.gapAlerts && shifts.some(function (x) { return x.VolunteerID; })) {
    var gaps = coverageGaps(shifts, today, opts.gapDays).gaps;
    var fresh = gaps.filter(function (d) { return !log['gap|' + d]; });
    if (fresh.length) {
      out.push({ key: fresh.map(function (d) { return 'gap|' + d; }), kind: 'gap', volunteerId: '', toAdmins: true,
        subject: 'Call coverage: ' + gaps.length + ' open day' + (gaps.length > 1 ? 's' : '') + ' in the next ' + opts.gapDays + ' days',
        body: 'These days have no one on call:\n\n' + gaps.map(function (d) { return '- ' + d + (fresh.indexOf(d) !== -1 ? ' (new)' : ''); }).join('\n') });
    }
  }
  return out;
}

/** Volunteers who can be named on the call calendar: they take call and haven't left. */
function calendarPeople(volunteers) {
  return volunteers.filter(function (v) { return takesCall(v) && v.Status !== 'Departed' && v.Status !== 'Inactive'; });
}

/**
 * Who an event title names: { volunteerId } when exactly one person matches,
 * else { volunteerId: '', ambiguous }. A full name (or preferred + last name)
 * as whole words beats a shared last name: "Emily Walls" is Emily, not Sam
 * Walls; "Dr. Walls" matches both and is left for an admin.
 * everyone: all volunteers, so a full name belonging to someone who doesn't
 * take call ("Rita Lee", an RN) isn't read as a physician who shares the last name.
 */
function matchVolunteerTitle(title, people, everyone) {
  var words = function (s) { return ' ' + String(s || '').toLowerCase().replace(/[^a-zÀ-ɏ']+/g, ' ').trim() + ' '; };
  var t = words(title);
  var has = function (n) { var w = words(n); return w.trim().length > 1 && t.indexOf(w) !== -1; };
  var last = function (v) { return String(v.Name || '').trim().split(/\s+/).pop(); };
  var full = function (v) { return has(v.Name) || (v.PreferredName && has(v.PreferredName + ' ' + last(v))); };
  var hits = people.filter(full);
  if (!hits.length && (everyone || []).some(full)) return { volunteerId: '', ambiguous: false };
  if (!hits.length) hits = people.filter(function (v) { return has(last(v)); });
  return { volunteerId: hits.length === 1 ? hits[0].VolunteerID : '', ambiguous: hits.length > 1 };
}

/**
 * Matches events from an existing call calendar to volunteers who take call.
 * events: [{ date, title, eventId }] (an all-day event spanning days arrives as one per day).
 * A title naming nobody, or two people, is left for the admin to pick.
 */
function matchImportEvents(events, volunteers, byDate) {
  var people = calendarPeople(volunteers);
  return events.map(function (e) {
    var m = matchVolunteerTitle(e.title, people, volunteers);
    var taken = byDate[e.date];
    return {
      date: e.date, title: e.title, eventId: e.eventId || '',
      volunteerId: m.volunteerId,
      note: taken ? 'Already claimed in HFJ' : m.ambiguous ? 'Matches more than one person' : m.volunteerId ? '' : 'No name matched',
      skip: !!taken
    };
  });
}

/**
 * Two-way sync, calendar → app: what to change so the app matches the call
 * calendar between opts.from and opts.to (the app → calendar direction
 * happens as each change is made). Pure; CalendarSync.gs applies it.
 *
 * events: [{ eventId, title, dates: [...] }] on the call calendar (an all-day
 *   event spanning days, or a recurring one, carries several dates).
 * shifts: CallShifts rows. A claim is linked to its event by CalendarEventId,
 *   and EventTitle is the title when it was linked.
 * opts: { from, to, ignored: { eventId: true } }
 *
 * Returns:
 *   releases: [{ row, reason }]  deleted, moved, or renamed to someone else
 *   claims:   [{ date, volunteerId, eventId, title }]  new, or the far side of a move
 *   retitles: [{ row, title }]  a linked event's title changed without changing who
 *   flags:    [{ eventId, title, dates, problem }]  for an admin to sort out
 *
 * Rules:
 * - A linked event that's gone releases its days.
 * - An event belongs to the volunteer its title names. Once linked, it stays
 *   with that volunteer unless the title is changed to name someone else, so
 *   an admin's choice for an ambiguous title ("Dr. Walls") sticks.
 * - Days the event no longer covers are released; days it newly covers are
 *   claimed, unless someone else has the day (flagged as a conflict).
 * - A day the app released while the event stayed (one day of a multi-day or
 *   recurring event) isn't claimed again.
 * - Past days are history and never touched.
 */
function reconcileCalendar(events, shifts, volunteers, opts) {
  var people = calendarPeople(volunteers);
  var ignored = opts.ignored || {};
  var inWindow = function (d) { return d >= opts.from && d <= opts.to; };
  var active = shifts.filter(function (s) { return s.VolunteerID && !s.ReleasedAt && inWindow(s.ShiftDate); });
  var released = {};
  shifts.forEach(function (s) {
    if (s.ReleasedAt && s.CalendarEventId && s.ReleasedBy !== 'calendar') released[s.CalendarEventId + '|' + s.ShiftDate] = true;
  });
  var byEvent = {}, byDate = {};
  active.forEach(function (s) {
    byDate[s.ShiftDate] = s;
    if (s.CalendarEventId) (byEvent[s.CalendarEventId] = byEvent[s.CalendarEventId] || []).push(s);
  });
  var eventsById = {};
  events.forEach(function (e) { eventsById[e.eventId] = e; });

  var out = { releases: [], claims: [], retitles: [], flags: [] };
  var release = function (s, reason) { out.releases.push({ row: s, reason: reason }); if (byDate[s.ShiftDate] === s) delete byDate[s.ShiftDate]; };

  Object.keys(byEvent).forEach(function (id) {
    if (!eventsById[id]) byEvent[id].forEach(function (s) { release(s, 'removed from the calendar'); });
  });

  events.forEach(function (e) {
    var dates = e.dates.filter(inWindow);
    var linked = byEvent[e.eventId] || [];
    var match = matchVolunteerTitle(e.title, people, volunteers);
    var owner = linked.length ? linked[0].VolunteerID : '';
    var renamed = linked.some(function (s) { return s.EventTitle && s.EventTitle !== e.title; });
    var target = !owner ? match.volunteerId : renamed && match.volunteerId ? match.volunteerId : owner;
    if (!target) {
      if (dates.length && !ignored[e.eventId]) {
        out.flags.push({ eventId: e.eventId, title: e.title, dates: dates,
          problem: match.ambiguous ? 'Matches more than one volunteer' : 'Doesn\'t name a volunteer who takes call' });
      }
      return;
    }
    var kept = {};
    linked.forEach(function (s) {
      if (s.VolunteerID !== target) release(s, 'renamed on the calendar');
      else if (dates.indexOf(s.ShiftDate) === -1) release(s, 'moved on the calendar');
      else {
        kept[s.ShiftDate] = true;
        if (s.EventTitle !== e.title) out.retitles.push({ row: s, title: e.title });
      }
    });
    var conflicts = [];
    dates.forEach(function (d) {
      if (kept[d] || released[e.eventId + '|' + d]) return;
      var other = byDate[d];
      if (other) { if (other.VolunteerID !== target) conflicts.push(d); return; }
      out.claims.push({ date: d, volunteerId: target, eventId: e.eventId, title: e.title });
      byDate[d] = { VolunteerID: target, ShiftDate: d };
    });
    if (conflicts.length && !ignored[e.eventId]) {
      out.flags.push({ eventId: e.eventId, title: e.title, dates: conflicts, problem: 'Someone else already has this day in the app' });
    }
  });
  return out;
}
