/**
 * Reminder planning (spec §8). Pure: decides what to send; Daily.gs sends it.
 *
 * Each reminder has a stable key. ReminderLog records the last send per key,
 * so a reminder goes out once (or once per interval for overdue items) even if
 * the daily trigger misses a day or runs twice.
 *
 * Call-related reminders (on call tomorrow, coverage gaps) arrive with the
 * calendar in Phase 3.
 *
 * opts: { leadDays, overdueIntervalDays, attestationLeadDays, sendToVolunteers }
 * log:  { key: { lastSent: 'yyyy-MM-dd' } }
 */
function planReminders(data, today, opts, log) {
  var out = [];
  var credsBy = groupBy(data.credentials, 'VolunteerID');

  data.volunteers.forEach(function (v) {
    if (CURRENT_STATUSES.indexOf(v.Status) === -1) return;
    var who = v.PreferredName || v.Name;
    var volunteerTo = opts.sendToVolunteers && v.Email ? v.Email : '';
    var creds = credsBy[v.VolunteerID] || [];

    creds.forEach(function (c) {
      if (!isIsoDate(c.ExpirationDate) || isSuperseded(c, creds)) return;
      var days = daysBetween(today, c.ExpirationDate);

      if (days >= 0 && days <= opts.leadDays) {
        var key = 'expiring|' + c.CredentialID + '|' + c.ExpirationDate;
        if (!log[key]) {
          out.push({
            key: key, kind: 'expiring', volunteerId: v.VolunteerID,
            volunteerTo: volunteerTo, toAdmins: true,
            subject: 'HFJ: ' + c.Type + ' expires ' + c.ExpirationDate,
            body: 'Hi ' + who + ',\n\nYour ' + c.Type + ' on file with HFJ expires on ' +
              c.ExpirationDate + ' (' + days + ' days). Please renew it and send HFJ the updated ' +
              'expiration date so you can stay on the call schedule.\n\nThank you.',
            adminBody: v.Name + ' (' + v.VolunteerID + '): ' + c.Type + ' expires ' +
              c.ExpirationDate + ' (' + days + ' days).'
          });
        }
      } else if (days < 0) {
        var okey = 'expired|' + c.CredentialID + '|' + c.ExpirationDate;
        var last = log[okey] && log[okey].lastSent;
        if (!last || daysBetween(last, today) >= opts.overdueIntervalDays) {
          out.push({
            key: okey, kind: 'expired', volunteerId: v.VolunteerID,
            volunteerTo: volunteerTo, toAdmins: true,
            subject: 'HFJ: ' + c.Type + ' expired ' + c.ExpirationDate,
            body: 'Hi ' + who + ',\n\nOur records show your ' + c.Type + ' expired on ' +
              c.ExpirationDate + '. You can\'t take call with HFJ until HFJ has your renewed ' +
              'credential on file. Please send the new expiration date when you have it.\n\nThank you.',
            adminBody: v.Name + ' (' + v.VolunteerID + '): ' + c.Type + ' expired ' +
              c.ExpirationDate + '. Ineligible for call until resolved.'
          });
        }
      }
    });

    if (volunteerTo && isIsoDate(v.LastAttestationDate)) {
      var due = addYears(v.LastAttestationDate, 1);
      var left = daysBetween(today, due);
      var akey = 'attestation|' + v.VolunteerID + '|' + due;
      if (left >= 0 && left <= opts.attestationLeadDays && !log[akey]) {
        out.push({
          key: akey, kind: 'attestation', volunteerId: v.VolunteerID,
          volunteerTo: volunteerTo, toAdmins: false,
          subject: 'HFJ: annual volunteer attestation due ' + due,
          body: 'Hi ' + who + ',\n\nYour annual HFJ volunteer attestation is due by ' + due +
            '. HFJ will send you a link to complete it.\n\nThank you.'
        });
      }
    }
  });

  return out;
}

/**
 * Emails asking volunteers to review documents that changed since they
 * signed (see outdatedDocuments). One email per volunteer covers every
 * outdated document; it repeats every `intervalDays` until they're done, and
 * a new update to any document starts the count again. Volunteer-only: the
 * dashboard shows admins who is still outstanding.
 *
 * sigsBy: { VolunteerID: [signature rows] }  documents: getDocuments_() shape
 */
function planDocumentUpdates(volunteers, sigsBy, documents, today, intervalDays, log) {
  var out = [];
  volunteers.forEach(function (v) {
    if (CURRENT_STATUSES.indexOf(v.Status) === -1 || !v.Email) return;
    var stale = outdatedDocuments(v, sigsBy[v.VolunteerID] || [], documents, today);
    if (!stale.length) return;
    var key = 'docupdate|' + v.VolunteerID + '|' + stale.map(function (o) { return o.docKey + '@' + o.version; }).join(',');
    var last = log[key] && log[key].lastSent;
    if (last && daysBetween(last, today) < intervalDays) return;
    out.push({ key: key, volunteerId: v.VolunteerID, documents: stale, reminder: !!last });
  });
  return out;
}

/** The email for one planDocumentUpdates item. `link` is the volunteer's fresh personal link. */
function documentUpdateEmail(v, item, link) {
  var first = String(v.PreferredName || v.Name || '').split(' ')[0];
  var one = item.documents.length === 1;
  return {
    subject: (item.reminder ? 'Reminder: ' : '') + 'HFJ updated ' + (one ? item.documents[0].title : 'documents you signed'),
    body: [
      'Hi ' + first + ',',
      '',
      'HFJ has updated ' + (one ? 'a document' : 'documents') + ' you previously ' +
        (item.documents.every(function (o) { return o.kind === 'ack'; }) ? 'acknowledged' : 'signed') +
        '. Please review the new version and confirm:',
      ''
    ].concat(item.documents.map(function (o) {
      return '- ' + o.title + ' (version ' + o.version + '): please ' + (o.kind === 'ack' ? 'acknowledge' : 'sign') + ' it again';
    }), [
      '',
      link,
      '',
      'It takes a few minutes. This link is personal to you and replaces any earlier HFJ link. Please don\'t forward it.',
      '',
      'Thank you,',
      'Healthcare for Justice'
    ]).join('\n')
  };
}
