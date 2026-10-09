/**
 * Daily time-driven job (installed by installTriggers): refresh computed
 * statuses, then send due reminders. Runs as the account that installed it.
 */
function dailyJob() {
  var actor = { email: 'system', name: 'Daily job' };
  var today = today_();
  var policy = policy_();

  withLock_(function () {
    var data = loadAll_();
    var reqsBy = groupBy(data.requirements, 'VolunteerID');
    var credsBy = groupBy(data.credentials, 'VolunteerID');
    data.volunteers.forEach(function (v) {
      if (CURRENT_STATUSES.indexOf(v.Status) === -1) return;
      var e = evaluateEligibility(v, reqsBy[v.VolunteerID] || [], credsBy[v.VolunteerID] || [], today,
        { bgIntervalMonths: policy.bgIntervalMonths, ignoreStatus: true });
      writeComputedStatuses_(e, actor);
    });
  });

  sendReminders_(today, policy);
}

function sendReminders_(today, policy) {
  var data = loadAll_();
  var logRows = readRows_(TABS.REMINDER_LOG);
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var log = {};
  logRows.forEach(function (r) {
    log[r.Key] = { lastSent: r.LastSentAt ? Utilities.formatDate(new Date(r.LastSentAt), tz, 'yyyy-MM-dd') : '', row: r };
  });

  var plan = planReminders(data, today, {
    leadDays: policy.reminderLeadDays,
    overdueIntervalDays: policy.overdueIntervalDays,
    attestationLeadDays: policy.attestationLeadDays,
    sendToVolunteers: policy.sendToVolunteers
  }, log);
  if (!plan.length) return;

  var admins = adminEmails_();
  var appUrl = ScriptApp.getService().getUrl() || '';
  plan.forEach(function (r) {
    try {
      if (r.volunteerTo) {
        MailApp.sendEmail({ to: r.volunteerTo, subject: r.subject, body: r.body, name: 'HFJ Volunteers' });
      }
      if (r.toAdmins && admins.length) {
        MailApp.sendEmail({
          to: admins.join(','), subject: '[Admin] ' + r.subject, name: 'HFJ Volunteers',
          body: r.adminBody + '\n\n' +
            (r.volunteerTo ? 'The volunteer was emailed too.' : 'The volunteer was NOT emailed (SendVolunteerReminders is off or no email on file).') +
            (appUrl ? '\n\nDashboard: ' + appUrl : '')
        });
      }
      var prev = log[r.key] && log[r.key].row;
      if (prev) updateRow_(TABS.REMINDER_LOG, prev._row, { LastSentAt: new Date(), SendCount: (prev.SendCount || 0) + 1 });
      else appendRow_(TABS.REMINDER_LOG, { Key: r.key, LastSentAt: new Date(), SendCount: 1 });
      logAudit_('system', 'reminder.' + r.kind, 'Volunteer', r.volunteerId,
        r.subject + ' → ' + [r.volunteerTo, r.toAdmins ? 'admins' : ''].filter(String).join(', '));
    } catch (err) {
      logAudit_('system', 'reminder.error', 'Volunteer', r.volunteerId, r.key + ': ' + err.message);
    }
  });
}
