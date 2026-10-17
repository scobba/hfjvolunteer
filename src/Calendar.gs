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

/**
 * Matches events from an existing call calendar to volunteers who take call.
 * events: [{ date, title }] (an all-day event spanning days arrives as one per day).
 * A volunteer matches when their full name (or preferred + last name) is in the
 * title as whole words, or failing that their last name; a title naming
 * nobody, or two people, is left for the admin to pick.
 */
function matchImportEvents(events, volunteers, byDate) {
  var people = volunteers.filter(function (v) { return takesCall(v) && v.Status !== 'Departed'; });
  var words = function (s) { return ' ' + String(s || '').toLowerCase().replace(/[^a-zÀ-ɏ']+/g, ' ').trim() + ' '; };
  return events.map(function (e) {
    var t = words(e.title);
    var has = function (n) { var w = words(n); return w.trim().length > 1 && t.indexOf(w) !== -1; };
    var last = function (v) { return String(v.Name || '').trim().split(/\s+/).pop(); };
    // A full name beats a shared last name ("Emily Walls" is Emily, not Sam Walls).
    var hits = people.filter(function (v) { return has(v.Name) || (v.PreferredName && has(v.PreferredName + ' ' + last(v))); });
    if (!hits.length) hits = people.filter(function (v) { return has(last(v)); });
    var taken = byDate[e.date];
    return {
      date: e.date, title: e.title, eventId: e.eventId || '',
      volunteerId: hits.length === 1 ? hits[0].VolunteerID : '',
      note: taken ? 'Already claimed in HFJ' : hits.length > 1 ? 'Matches more than one person' : hits.length ? '' : 'No name matched',
      skip: !!taken
    };
  });
}
