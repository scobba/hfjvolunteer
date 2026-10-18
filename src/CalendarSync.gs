/**
 * Two-way calendar sync, calendar → app (Phase 3). Changes made directly on
 * the call calendar (adding, deleting, moving or renaming a day) reach the app
 * every 15 minutes (calendarSync trigger), and whenever the Calendar page or a
 * volunteer's calendar opens. The app → calendar direction happens as each
 * change is made in the app (CallShifts.gs).
 *
 * reconcileCalendar (Calendar.gs) decides; this applies. What it can't decide
 * goes on a "needs a look" list for admins, kept in script properties.
 */

var CALENDAR_ACTOR = { email: 'calendar', name: 'Google Calendar' };
var SYNC_MIN_SECONDS = 120;
var SYNC_MAX_CLAIMS = 60; // per run, so a first sync of a full calendar stays inside the time limit

function syncProps_() { return PropertiesService.getScriptProperties(); }

function readJsonProp_(key, fallback) {
  try { return JSON.parse(syncProps_().getProperty(key) || '') || fallback; } catch (e) { return fallback; }
}

/** Every event on the call calendar between two dates: [{ eventId, title, dates }]. */
function readCalendarEvents_(cal, from, to) {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var start = Utilities.parseDate(from + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  var end = Utilities.parseDate(addDays(to, 1) + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  var byId = {}, order = [];
  cal.getEvents(start, end).forEach(function (ev) {
    var id = ev.getId();
    var e = byId[id];
    if (!e) { e = byId[id] = { eventId: id, title: String(ev.getTitle() || ''), dates: [] }; order.push(id); }
    if (ev.isAllDayEvent()) {
      var last = Utilities.formatDate(ev.getAllDayEndDate(), tz, 'yyyy-MM-dd');
      for (var d = Utilities.formatDate(ev.getAllDayStartDate(), tz, 'yyyy-MM-dd'); d < last; d = addDays(d, 1)) e.dates.push(d);
    } else {
      e.dates.push(Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'));
    }
  });
  return order.map(function (id) { return byId[id]; });
}

/**
 * Brings the app in line with the call calendar. Inside the lock. Returns
 * { claimed, released, flags } or { skipped } when there's no calendar this
 * account can open.
 */
function syncFromCalendar_() {
  var cal = callCalendar_();
  if (!cal) return { skipped: true };
  var p = policy_();
  var today = today_();
  var to = addDays(today, p.calendarHorizonDays);
  var events = readCalendarEvents_(cal, today, to);
  var shifts = readRows_(TABS.CALL_SHIFTS);
  var ignored = {};
  readJsonProp_('calendarIgnored', []).forEach(function (id) { ignored[id] = true; });
  var plan = reconcileCalendar(events, shifts, readRows_(TABS.VOLUNTEERS), { from: today, to: to, ignored: ignored });

  // A calendar that suddenly looks empty is more likely a permissions problem than a mass cancellation.
  var linked = shifts.filter(function (s) { return s.VolunteerID && !s.ReleasedAt && s.CalendarEventId && s.ShiftDate >= today && s.ShiftDate <= to; }).length;
  var removed = plan.releases.filter(function (r) { return r.reason === 'removed from the calendar'; }).length;
  if (removed > 5 && removed > linked / 2) {
    var key = 'calendar-mass-removal|' + today;
    if (!readRows_(TABS.REMINDER_LOG).some(function (r) { return r.Key === key; })) {
      appendRow_(TABS.REMINDER_LOG, { Key: key, LastSentAt: new Date(), SendCount: 1 });
      notifyAdmins_('Calendar sync paused: ' + removed + ' call days missing from Google Calendar', [
        removed + ' of the ' + linked + ' upcoming call days in the app are no longer on the call calendar.',
        'The sync stopped rather than release them all. If they were deleted on purpose, clear them on the Calendar page; ' +
        'otherwise check the calendar is still shared with the HFJ Volunteers account.']);
    }
    logAudit_(CALENDAR_ACTOR, 'calendar.paused', 'Calendar', cal.getId(), removed + ' of ' + linked + ' days missing');
    return { paused: true, removed: removed };
  }

  var reclaimed = {};
  plan.claims.forEach(function (c) { reclaimed[c.date] = true; });
  plan.releases.forEach(function (r) {
    updateRow_(TABS.CALL_SHIFTS, r.row._row, { ReleasedAt: new Date(), ReleasedBy: CALENDAR_ACTOR.email });
    logAudit_(CALENDAR_ACTOR, 'shift.release', 'CallShift', r.row.ShiftDate, r.row.VolunteerID + ' (' + r.reason + ')');
    if (!reclaimed[r.row.ShiftDate]) notifyLateRelease_(r.row, 'was ' + r.reason);
  });
  plan.retitles.forEach(function (t) { updateRow_(TABS.CALL_SHIFTS, t.row._row, { EventTitle: t.title }); });
  var flags = plan.flags.slice();
  var claimed = 0;
  plan.claims.slice(0, SYNC_MAX_CLAIMS).forEach(function (c) {
    try {
      claimShift_(c.volunteerId, c.date, CALENDAR_ACTOR, { byAdmin: true, source: 'calendar', eventId: c.eventId, eventTitle: c.title, invite: false, warnAdmins: true });
      claimed++;
    } catch (e) {
      flags.push({ eventId: c.eventId, title: c.title, dates: [c.date], problem: e.message });
    }
  });
  saveCalendarReview_(flags);
  return { claimed: claimed, released: plan.releases.length, flags: flags.length };
}

/** Stores the "needs a look" list and emails admins about items they haven't heard about. */
function saveCalendarReview_(flags) {
  syncProps_().setProperty('calendarReview', JSON.stringify({ at: new Date().toISOString(), flags: flags }));
  var told = readJsonProp_('calendarReviewTold', []);
  var fresh = flags.filter(function (f) { return told.indexOf(f.eventId + '|' + f.problem) === -1; });
  syncProps_().setProperty('calendarReviewTold', JSON.stringify(flags.map(function (f) { return f.eventId + '|' + f.problem; })));
  if (!fresh.length) return;
  notifyAdmins_('Call calendar: ' + fresh.length + ' event' + (fresh.length > 1 ? 's need' : ' needs') + ' a look', [
    'These events on the call calendar couldn\'t be matched to the app. Sort them out on the Calendar page (assign or ignore).', '']
    .concat(fresh.map(function (f) { return '- ' + f.dates.join(', ') + ' "' + f.title + '": ' + f.problem; })));
}

/** The current "needs a look" list. */
function calendarReview_() {
  return readJsonProp_('calendarReview', { at: '', flags: [] });
}

/** Syncs unless that happened in the last couple of minutes. Never throws: a page must still load. */
function maybeSyncCalendar_() {
  var last = Number(syncProps_().getProperty('calendarSyncedAt') || 0);
  if (Date.now() - last < SYNC_MIN_SECONDS * 1000) return;
  try {
    withLock_(function () {
      syncProps_().setProperty('calendarSyncedAt', String(Date.now()));
      syncFromCalendar_();
    });
  } catch (e) {
    try { logAudit_(CALENDAR_ACTOR, 'calendar.error', 'Calendar', '', 'Sync: ' + e.message); } catch (ignore) {}
  }
}

/** The 15-minute trigger (installTriggers). Also runnable by the app's account or an admin. */
function calendarSync(e) {
  requireJobCaller_(e);
  withLock_(function () {
    syncProps_().setProperty('calendarSyncedAt', String(Date.now()));
    syncFromCalendar_();
  });
}
