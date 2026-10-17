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

/** The HFJ On Call calendar, created on first use by whoever the app runs as. */
function ensureCallCalendar_() {
  var id = String(getSettings_().CallCalendarId || '').trim();
  var cal = id ? CalendarApp.getCalendarById(id) : null;
  if (cal) return cal;
  cal = CalendarApp.createCalendar(CALL_CALENDAR_NAME, {
    timeZone: getSpreadsheet_().getSpreadsheetTimeZone(),
    summary: 'Healthcare for Justice call schedule. Managed by the HFJ Volunteers app; changes made here are overwritten.'
  });
  setSetting_('CallCalendarId', cal.getId());
  logAudit_('system', 'calendar.create', 'Calendar', cal.getId(), CALL_CALENDAR_NAME + (id ? ' (the saved one was not reachable)' : ''));
  return cal;
}

/**
 * Run once from the Apps Script editor, signed in as the account the web app
 * runs as, to approve the calendar permission and create the calendar.
 */
function authorizeCalendar() {
  // Through a web page this runs as volunteers@ for a visitor; only its owner, in the editor, may run it.
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (!me || currentEmail_() !== me) throw new Error('Run authorizeCalendar from the Apps Script editor.');
  var cal = ensureCallCalendar_();
  Logger.log('HFJ On Call calendar: ' + cal.getId());
  return cal.getId();
}

/** Adds the event for a claim and stores its id. Never throws: the claim stands either way. */
function syncShiftEvent_(row, v, invite) {
  try {
    var times = shiftTimes_(row.ShiftDate);
    var opts = { description: 'Healthcare for Justice call, 24 hours from ' + shiftStartTime_() + '.\n' +
      'To give up this day, use your personal HFJ volunteer link, or contact HFJ.' };
    if (invite && v.Email) { opts.guests = v.Email; opts.sendInvites = true; }
    var ev = ensureCallCalendar_().createEvent('HFJ on call: ' + v.Name, times.start, times.end, opts);
    updateRow_(TABS.CALL_SHIFTS, row._row, { CalendarEventId: ev.getId() });
    return true;
  } catch (e) {
    logAudit_('system', 'calendar.error', 'CallShift', row.ShiftDate, v.VolunteerID + ': ' + e.message);
    return false;
  }
}

function removeShiftEvent_(row) {
  if (!row.CalendarEventId) return;
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
 * opts: { byAdmin, source: 'portal' | 'admin' | 'import', invite }
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
  syncShiftEvent_(row, v, opts.invite !== false);
  if (!e.eligible && !opts.byAdmin) {
    notifyAdmins_(v.Name + ' claimed ' + date + ' but isn\'t eligible', [
      v.Name + ' (' + volunteerId + ') claimed call on ' + date + '. Eligibility is warn-only (BlockIneligibleClaims = FALSE), so the claim stands.',
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
  var p = policy_();
  if (!byAdmin && daysBetween(today_(), date) <= p.lateReleaseDays) {
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', row.VolunteerID);
    notifyAdmins_('Call day open again: ' + date, [
      v.Name + ' (' + v.VolunteerID + ') released their call day on ' + date + ', ' + daysBetween(today_(), date) + ' day(s) from now.',
      'No one is on call that day yet.']);
  }
}

/** Adds calendar events for upcoming claims that don't have one (a failed sync). */
function syncMissingEvents_() {
  var today = today_();
  var volunteers = {};
  readRows_(TABS.VOLUNTEERS).forEach(function (v) { volunteers[v.VolunteerID] = v; });
  var n = 0;
  readRows_(TABS.CALL_SHIFTS).forEach(function (s) {
    if (!s.VolunteerID || s.ReleasedAt || s.CalendarEventId || s.ShiftDate < today || !volunteers[s.VolunteerID]) return;
    if (syncShiftEvent_(s, volunteers[s.VolunteerID], s.Source !== 'import')) n++;
  });
  return n;
}

/**
 * Reads an existing call calendar (shared with this account) between two
 * dates, as [{ date, title }]: an all-day event becomes one item per day, a
 * timed one is dated by its start.
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
      for (; d < last; d = addDays(d, 1)) if (d >= from && d <= to) out.push({ date: d, title: title });
    } else {
      out.push({ date: Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'), title: title });
    }
  });
  return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}
