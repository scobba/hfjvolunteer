/** Settings tab: key/value, so policy changes don't need a code change. */

function getSettings_() {
  var out = {};
  SETTING_DEFAULTS.forEach(function (d) { out[d[0]] = d[1]; });
  try {
    readRows_(TABS.SETTINGS).forEach(function (r) { if (r.Key) out[r.Key] = String(r.Value).trim(); });
  } catch (e) {
    // Before setup the tab doesn't exist; defaults apply.
  }
  return out;
}

function settingInt_(settings, key, fallback) {
  var n = parseInt(settings[key], 10);
  return isNaN(n) ? fallback : n;
}

function settingBool_(settings, key) {
  return String(settings[key]).toUpperCase() === 'TRUE';
}

/** The parsed policy values the pure modules take. */
function policy_() {
  var s = getSettings_();
  return {
    bgIntervalMonths: settingInt_(s, 'BackgroundCheckIntervalMonths', null),
    reminderLeadDays: settingInt_(s, 'ReminderLeadDays', 60),
    overdueIntervalDays: settingInt_(s, 'OverdueReminderIntervalDays', 30),
    attestationLeadDays: settingInt_(s, 'AttestationReminderLeadDays', 30),
    sendToVolunteers: settingBool_(s, 'SendVolunteerReminders'),
    blockIneligibleClaims: settingBool_(s, 'BlockIneligibleClaims'),
    calendarHorizonDays: settingInt_(s, 'CalendarHorizonDays', 180)
  };
}

function today_() {
  return Utilities.formatDate(new Date(), getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}
