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
  if (policy.sendUpdateRequests) sendDocumentUpdates_(today, policy);
}

/** Emails volunteers whose signed documents have a newer Version (planDocumentUpdates). */
function sendDocumentUpdates_(today, policy) {
  if (!deployedUrls_().volunteerUrl) return;
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var log = {};
  readRows_(TABS.REMINDER_LOG).forEach(function (r) {
    log[r.Key] = { lastSent: r.LastSentAt ? Utilities.formatDate(new Date(r.LastSentAt), tz, 'yyyy-MM-dd') : '', row: r };
  });
  var plan = planDocumentUpdates(readRows_(TABS.VOLUNTEERS), groupBy(readRows_(TABS.SIGNATURES), 'VolunteerID'),
    getDocuments_(), today, policy.updateReminderDays, log);
  var actor = { email: 'system', name: 'Daily job' };
  plan.forEach(function (item) {
    try {
      // Only the hash of a link is stored, so each email carries a fresh one (replacing the old).
      var sent = withLock_(function () {
        var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', item.volunteerId);
        var mail = documentUpdateEmail(v, item, portalUrl_('t', issueToken_(v, actor)));
        MailApp.sendEmail({ to: v.Email, subject: mail.subject, body: mail.body, name: 'HFJ Volunteers' });
        var prev = log[item.key] && log[item.key].row;
        if (prev) updateRow_(TABS.REMINDER_LOG, prev._row, { LastSentAt: new Date(), SendCount: (prev.SendCount || 0) + 1 });
        else appendRow_(TABS.REMINDER_LOG, { Key: item.key, LastSentAt: new Date(), SendCount: 1 });
        return v;
      });
      logAudit_('system', 'reminder.documentUpdate', 'Volunteer', item.volunteerId, sent.Email + ': ' +
        item.documents.map(function (o) { return o.title + ' v' + o.signedVersion + ' → v' + o.version; }).join('; '));
    } catch (err) {
      logAudit_('system', 'reminder.error', 'Volunteer', item.volunteerId, item.key + ': ' + err.message);
    }
  });
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
