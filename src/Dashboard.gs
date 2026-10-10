/**
 * Admin dashboard blocks (spec §6). Pure: takes plain rows, returns plain data.
 *
 * data: { volunteers, credentials, requirements, shifts }
 * opts: { reminderLeadDays, bgIntervalMonths }
 */

var CURRENT_STATUSES = ['Prospective', 'Active'];

function groupBy(rows, field) {
  var out = {};
  rows.forEach(function (r) { (out[r[field]] = out[r[field]] || []).push(r); });
  return out;
}

function buildDashboard(data, today, opts) {
  var credsBy = groupBy(data.credentials, 'VolunteerID');
  var reqsBy = groupBy(data.requirements, 'VolunteerID');
  var names = {};
  data.volunteers.forEach(function (v) { names[v.VolunteerID] = v.Name; });
  var awaitingHfj = (data.signatures || []).filter(function (s) { return s.Status === 'Awaiting HFJ'; })
    .map(function (s) {
      return { signatureId: s.SignatureID, volunteerId: s.VolunteerID, name: names[s.VolunteerID] || s.VolunteerID,
        title: s.DocTitle, version: s.DocVersion, signedAt: String(s.SignedAt).slice(0, 10) };
    });
  var lead = opts.reminderLeadDays || 60;
  var current = data.volunteers.filter(function (v) { return CURRENT_STATUSES.indexOf(v.Status) !== -1; });

  var needsReview = [], expiring = [], ineligible = [], onboarding = [];

  current.forEach(function (v) {
    var creds = credsBy[v.VolunteerID] || [];
    var person = { volunteerId: v.VolunteerID, name: v.Name, credential: v.Credential };

    creds.forEach(function (c) {
      var type = CREDENTIAL_TYPES[c.Type] || {};
      if (needsVerification(c, v)) {
        needsReview.push(Object.assign({}, person, {
          credentialId: c.CredentialID, type: c.Type, licenseNumber: c.LicenseNumber,
          expirationDate: c.ExpirationDate, uploadedDocUrl: c.UploadedDocUrl,
          board: type.board || '', lookupUrl: type.lookupUrl || '',
          why: isVerified(c) ? 'Re-verify: attested since last verification' : 'Not yet verified'
        }));
      }
      if (isIsoDate(c.ExpirationDate) && !isSuperseded(c, creds)) {
        var days = daysBetween(today, c.ExpirationDate);
        if (days >= 0 && days <= lead) {
          expiring.push(Object.assign({}, person, {
            credentialId: c.CredentialID, type: c.Type, expirationDate: c.ExpirationDate,
            daysLeft: days, window: days <= 30 ? 30 : 60
          }));
        }
      }
    });

    var reqs = reqsBy[v.VolunteerID] || [];
    if (v.Status === 'Active') {
      var e = evaluateEligibility(v, reqs, creds, today, { bgIntervalMonths: opts.bgIntervalMonths });
      if (!e.eligible) ineligible.push(Object.assign({}, person, { reasons: e.reasons }));
    } else {
      var p = evaluateEligibility(v, reqs, creds, today,
        { bgIntervalMonths: opts.bgIntervalMonths, ignoreStatus: true });
      var open = p.items.filter(function (i) { return !i.ok; });
      var stuck = open[0];
      onboarding.push(Object.assign({}, person, {
        done: p.items.length - open.length, total: p.items.length,
        stuckOn: stuck ? stuck.label : (p.unknownCredential ? 'Set a recognized credential' : 'Ready to activate'),
        stuckOwner: stuck ? stuck.owner : 'admin'
      }));
    }
  });

  expiring.sort(function (a, b) { return a.daysLeft - b.daysLeft; });

  return {
    today: today,
    needsReview: needsReview,
    awaitingHfj: awaitingHfj,
    expiring: expiring,
    ineligible: ineligible,
    onboarding: onboarding,
    coverage: coverageGaps(data.shifts, today, 14),
    counts: {
      active: data.volunteers.filter(function (v) { return v.Status === 'Active'; }).length,
      prospective: onboarding.length
    }
  };
}

/** Uncovered call days in the next `days` days. Not live until the calendar (Phase 3) has data. */
function coverageGaps(shifts, today, days) {
  if (!shifts.length) return { live: false, gaps: [] };
  var covered = {};
  shifts.forEach(function (s) {
    if (s.VolunteerID && !s.ReleasedAt) covered[s.ShiftDate] = true;
  });
  var gaps = [];
  for (var i = 0; i < days; i++) {
    var d = addDays(today, i);
    if (!covered[d]) gaps.push(d);
  }
  return { live: true, gaps: gaps };
}
