/**
 * Claiming and releasing call days, and the Google Calendar sync (Phase 3).
 *
 * The "HFJ On Call" calendar belongs to the account the web app runs as
 * (volunteers@). Each claimed day is a 24-hour event on it, with the
 * volunteer as a guest so it lands on their own calendar. Event text names
 * the volunteer and nothing else: no PHI, no links.
 */

var CALL_CALENDAR_NAME = 'HFJ On Call';

function shiftStartTime_() {
  var t = String(getSettings_().ShiftStartTime || '').trim();
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(t) ? t : '17:00';
}

/** The shift's start and end as Dates, in the spreadsheet's time zone. */
function shiftTimes_(date) {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var t = shiftStartTime_();
  return {
    start: Utilities.parseDate(date + ' ' + t, tz, 'yyyy-MM-dd HH:mm'),
    end: Utilities.parseDate(addDays(date, 1) + ' ' + t, tz, 'yyyy-MM-dd HH:mm')
  };
}

function setSetting_(key, value) {
  var row = readRows_(TABS.SETTINGS).filter(function (r) { return r.Key === key; })[0];
  if (row) updateRow_(TABS.SETTINGS, row._row, { Value: value });
  else appendRow_(TABS.SETTINGS, { Key: key, Value: value, Notes: '' });
}

/**
 * The call calendar (Settings.CallCalendarId) if this account can open it,
 * else null. It's either the HFJ On Call calendar the app created, or an
 * existing HFJ calendar shared with the app's account (useCallCalendar_).
 */
function callCalendar_() {
  var id = String(getSettings_().CallCalendarId || '').trim();
  return id ? CalendarApp.getCalendarById(id) : null;
}

/**
 * The call calendar, creating HFJ On Call on first use if none is set. Only
 * a blank CallCalendarId creates one, so an account that can't open the
 * chosen calendar (an admin running the daily job from the Sheet menu) gets an
 * error rather than a second calendar.
 */
function ensureCallCalendar_() {
  var cal = callCalendar_();
  if (cal) return cal;
  var id = String(getSettings_().CallCalendarId || '').trim();
  if (id) throw new Error('Can\'t open the call calendar. It must be shared with the HFJ Volunteers account with "Make changes to events".');
  cal = CalendarApp.createCalendar(CALL_CALENDAR_NAME, {
    timeZone: getSpreadsheet_().getSpreadsheetTimeZone(),
    summary: 'Healthcare for Justice call schedule. Managed by the HFJ Volunteers app; changes made here are overwritten.'
  });
  setSetting_('CallCalendarId', cal.getId());
  logAudit_('system', 'calendar.create', 'Calendar', cal.getId(), CALL_CALENDAR_NAME);
  return cal;
}

/**
 * Run once from the Apps Script editor, signed in as the account the web app
 * runs as (volunteers@), to approve the calendar permission. It only reads, so
 * running it as anyone else can't create a calendar under the wrong account;
 * the web app creates HFJ On Call on the first claim or from the Calendar page.
 */
function authorizeCalendar() {
  // Callable from the portal page, where it runs as volunteers@ for a visitor; only the account itself may run it.
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!me || currentEmail_() !== me) throw new Error('Run authorizeCalendar from the Apps Script editor.');
  var cal = callCalendar_();
  var msg = cal ? 'Call calendar: ' + cal.getName() + ' (' + cal.getId() + ')' : 'Calendar access approved for ' + me + '.';
  Logger.log(msg);
  return msg;
}

/** Adds the event for a claim and stores its id. Never throws: the claim stands either way. */
function syncShiftEvent_(row, v, invite) {
  try {
    var times = shiftTimes_(row.ShiftDate);
    var opts = { description: 'Healthcare for Justice call, 24 hours from ' + shiftStartTime_() + '.\n' +
      'To give up this day, use your personal HFJ volunteer link, or contact HFJ.' };
    if (invite && v.Email) { opts.guests = v.Email; opts.sendInvites = true; }
    var title = 'HFJ on call: ' + v.Name;
    var ev = ensureCallCalendar_().createEvent(title, times.start, times.end, opts);
    updateRow_(TABS.CALL_SHIFTS, row._row, { CalendarEventId: ev.getId(), EventTitle: title });
    return true;
  } catch (e) {
    logAudit_('system', 'calendar.error', 'CallShift', row.ShiftDate, v.VolunteerID + ': ' + e.message);
    return false;
  }
}

function removeShiftEvent_(row) {
  if (!row.CalendarEventId) return;
  // An imported multi-day event covers several claims; it goes only with the last of them.
  var shared = readRows_(TABS.CALL_SHIFTS).some(function (s) {
    return s._row !== row._row && s.CalendarEventId === row.CalendarEventId && s.VolunteerID && !s.ReleasedAt;
  });
  if (shared) return;
  try {
    var ev = ensureCallCalendar_().getEventById(row.CalendarEventId);
    if (ev) ev.deleteEvent();
  } catch (e) {
    logAudit_('system', 'calendar.error', 'CallShift', row.ShiftDate, 'Removing event: ' + e.message);
  }
}

/**
 * Claims `date` for a volunteer. Inside the lock. Returns { warning } when the
 * volunteer isn't eligible on that date and BlockIneligibleClaims is off.
 * opts: { byAdmin, source: 'portal' | 'admin' | 'import' | 'calendar', invite, eventId, warnAdmins }
 * eventId: an event already on the call calendar for this day (an import from
 * that same calendar, or one added there directly), linked instead of adding a
 * duplicate. warnAdmins: email admins if not eligible even though byAdmin.
 */
function claimShift_(volunteerId, date, actor, opts) {
  var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', volunteerId);
  if (!v) throw new Error('No volunteer ' + volunteerId);
  var p = policy_();
  var today = today_();
  var shifts = readRows_(TABS.CALL_SHIFTS);
  var problem = claimProblem(v, date, activeShiftsByDate(shifts), { today: today, horizonDays: p.calendarHorizonDays, byAdmin: !!opts.byAdmin });
  if (problem) throw new Error(problem);
  if (!opts.byAdmin && date === today && new Date() >= shiftTimes_(date).start) throw new Error('Today\'s shift has already started. Please contact HFJ.');

  var reqs = readRows_(TABS.REQUIREMENTS).filter(function (r) { return r.VolunteerID === volunteerId; });
  var creds = readRows_(TABS.CREDENTIALS).filter(function (c) { return c.VolunteerID === volunteerId; });
  var e = evaluateEligibility(v, reqs, creds, date, { bgIntervalMonths: p.bgIntervalMonths, ignoreStatus: !!opts.byAdmin });
  if (!e.eligible && p.blockIneligibleClaims && !opts.byAdmin) {
    throw new Error('You can\'t take call on ' + date + ' yet: ' + e.reasons.join('; ') + '. Please contact HFJ.');
  }

  var row = { ShiftDate: date, VolunteerID: volunteerId, ClaimedAt: new Date(), ClaimedBy: actor.email, Source: opts.source };
  row._row = appendRow_(TABS.CALL_SHIFTS, row);
  logAudit_(actor, 'shift.claim', 'CallShift', date, volunteerId + (opts.source === 'portal' ? '' : ' (' + opts.source + ')') +
    (e.eligible ? '' : ' — not eligible: ' + e.reasons.join('; ')));
  var existing = null;
  if (opts.source === 'calendar') {
    // Read off the calendar moments ago (CalendarSync.gs): link it, never add a copy.
    updateRow_(TABS.CALL_SHIFTS, row._row, { CalendarEventId: String(opts.eventId), EventTitle: String(opts.eventTitle || '') });
  } else {
    if (opts.eventId) {
      try { existing = callCalendar_() && callCalendar_().getEventById(String(opts.eventId)); } catch (err) { existing = null; }
    }
    if (existing) updateRow_(TABS.CALL_SHIFTS, row._row, { CalendarEventId: existing.getId(), EventTitle: existing.getTitle() });
    else syncShiftEvent_(row, v, opts.invite !== false);
  }
  if (!e.eligible && (!opts.byAdmin || opts.warnAdmins)) {
    var how = opts.source === 'calendar' ? 'was put on call on ' + date + ' directly on the Google Calendar' : 'claimed call on ' + date;
    notifyAdmins_(v.Name + (opts.source === 'calendar' ? ' is on the calendar for ' : ' claimed ') + date + ' but isn\'t eligible', [
      v.Name + ' (' + volunteerId + ') ' + how + '. Eligibility is warn-only for this, so the day stands.',
      'Missing:'].concat(e.reasons.map(function (r) { return '- ' + r; })));
  }
  return { warning: e.eligible ? '' : e.reasons.join('; ') };
}

/**
 * Releases a claim. Volunteers release their own days before the shift starts;
 * a release inside LateReleaseDays emails the admins at once. Inside the lock.
 * volunteerId: the volunteer releasing, or '' for an admin clearing the day.
 */
function releaseShift_(volunteerId, date, actor, byAdmin) {
  var row = readRows_(TABS.CALL_SHIFTS).filter(function (s) {
    return s.ShiftDate === date && s.VolunteerID && !s.ReleasedAt && (byAdmin || s.VolunteerID === volunteerId);
  })[0];
  if (!row) throw new Error(byAdmin ? 'No one has ' + date + '.' : 'You don\'t have ' + date + '.');
  if (!byAdmin && new Date() >= shiftTimes_(date).start) throw new Error('This shift has already started. Please contact HFJ.');
  updateRow_(TABS.CALL_SHIFTS, row._row, { ReleasedAt: new Date(), ReleasedBy: actor.email });
  removeShiftEvent_(row);
  logAudit_(actor, 'shift.release', 'CallShift', date, row.VolunteerID + (byAdmin ? ' (by admin)' : ''));
  if (!byAdmin) notifyLateRelease_(row, 'released their call day');
}

/** Emails admins when a day inside LateReleaseDays is left uncovered. */
function notifyLateRelease_(row, what) {
  var days = daysBetween(today_(), row.ShiftDate);
  if (days < 0 || days > policy_().lateReleaseDays) return;
  var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', row.VolunteerID) || { Name: row.VolunteerID, VolunteerID: row.VolunteerID };
  notifyAdmins_('Call day open again: ' + row.ShiftDate, [
    v.Name + ' (' + v.VolunteerID + ') ' + what + ' on ' + row.ShiftDate + ', ' + days + ' day(s) from now.',
    'No one is on call that day yet.']);
}

/**
 * Adds calendar events for upcoming claims that don't have one (a failed
 * sync). Skipped by an account that can't open the calendar, and stops at the
 * first failure (an account that can only read it) rather than logging one
 * error per day.
 */
function syncMissingEvents_() {
  if (!callCalendar_()) return 0;
  var today = today_();
  var volunteers = {};
  readRows_(TABS.VOLUNTEERS).forEach(function (v) { volunteers[v.VolunteerID] = v; });
  var n = 0, failed = false;
  readRows_(TABS.CALL_SHIFTS).forEach(function (s) {
    if (failed || !s.VolunteerID || s.ReleasedAt || s.CalendarEventId || s.ShiftDate < today || !volunteers[s.VolunteerID]) return;
    if (syncShiftEvent_(s, volunteers[s.VolunteerID], s.Source !== 'import')) n++;
    else failed = true;
  });
  return n;
}

/**
 * Uses an existing Google Calendar (shared with this account with "Make changes
 * to events") for call days instead of creating HFJ On Call. Checks it can
 * write there with a throwaway event. Refused once upcoming days have events
 * on the current calendar, since those would be left behind. Inside the lock.
 */
function useCallCalendar_(calendarId, actor) {
  var id = String(calendarId || '').trim();
  var cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) throw new Error('Can\'t open that calendar. Share it with the HFJ Volunteers account with "Make changes to events", and check the calendar ID.');
  var current = String(getSettings_().CallCalendarId || '').trim();
  if (id === current) return cal;
  var today = today_();
  if (current && readRows_(TABS.CALL_SHIFTS).some(function (s) { return s.VolunteerID && !s.ReleasedAt && s.CalendarEventId && s.ShiftDate >= today; })) {
    throw new Error('Upcoming call days are already on the current calendar. Change calendars before days are claimed.');
  }
  try {
    var now = new Date();
    cal.createEvent('HFJ Volunteers access check', now, new Date(now.getTime() + 60000)).deleteEvent();
  } catch (e) {
    throw new Error('The HFJ Volunteers account can see that calendar but can\'t add events. Share it with "Make changes to events".');
  }
  setSetting_('CallCalendarId', id);
  logAudit_(actor, 'calendar.use', 'Calendar', id, cal.getName() + (current ? ' (was ' + current + ')' : ''));
  return cal;
}

/**
 * Reads an existing call calendar (shared with this account) between two
 * dates, as [{ date, title, eventId }]: an all-day event becomes one item per
 * day, a timed one is dated by its start.
 */
function readExternalCalendar_(calendarId, from, to) {
  var cal = CalendarApp.getCalendarById(String(calendarId || '').trim());
  if (!cal) throw new Error('Can\'t open that calendar. Share it with the HFJ Volunteers account (See all event details) and check the calendar ID.');
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var start = Utilities.parseDate(from + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  var end = Utilities.parseDate(addDays(to, 1) + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  var out = [];
  cal.getEvents(start, end).forEach(function (ev) {
    var title = String(ev.getTitle() || '');
    if (ev.isAllDayEvent()) {
      var d = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd');
      var last = Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd');
      for (; d < last; d = addDays(d, 1)) if (d >= from && d <= to) out.push({ date: d, title: title, eventId: ev.getId() });
    } else {
      out.push({ date: Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'), title: title, eventId: ev.getId() });
    }
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}
