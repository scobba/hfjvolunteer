/**
 * Server functions the admin page calls through google.script.run.
 * Each checks admin access first. Return values are plain JSON (no Dates).
 */

function api_bootstrap() {
  var admin = requireAdmin_();
  return {
    admin: admin,
    spreadsheetUrl: getSpreadsheet_().getUrl(),
    credentials: Object.keys(VOLUNTEER_CREDENTIALS),
    credentialTypes: Object.keys(CREDENTIAL_TYPES).map(function (t) {
      return { type: t, board: CREDENTIAL_TYPES[t].board, lookupUrl: CREDENTIAL_TYPES[t].lookupUrl };
    }),
    volunteerStatuses: VOLUNTEER_STATUSES,
    requirementStatuses: REQUIREMENT_STATUSES,
    backgroundDeterminations: BACKGROUND_DETERMINATIONS,
    blockIneligibleClaims: policy_().blockIneligibleClaims
  };
}

function api_dashboard() {
  requireAdmin_();
  var p = policy_();
  return buildDashboard(loadAll_(), today_(), { reminderLeadDays: p.reminderLeadDays, bgIntervalMonths: p.bgIntervalMonths });
}

function api_roster() {
  requireAdmin_();
  var data = loadAll_();
  var today = today_();
  var p = policy_();
  var reqsBy = groupBy(data.requirements, 'VolunteerID');
  var credsBy = groupBy(data.credentials, 'VolunteerID');
  return data.volunteers.map(function (v) {
    var creds = credsBy[v.VolunteerID] || [];
    var e = evaluateEligibility(v, reqsBy[v.VolunteerID] || [], creds, today, { bgIntervalMonths: p.bgIntervalMonths });
    var next = creds.filter(function (c) { return isIsoDate(c.ExpirationDate) && !isSuperseded(c, creds); })
      .map(function (c) { return c.ExpirationDate; }).sort()[0] || '';
    var done = e.items.filter(function (i) { return i.ok; }).length;
    return {
      VolunteerID: v.VolunteerID, Name: v.Name, PreferredName: v.PreferredName, Category: v.Category,
      Credential: v.Credential, Status: v.Status, Email: v.Email, CallTargetPerMonth: v.CallTargetPerMonth,
      eligible: e.eligible, reasons: e.reasons, nextExpiration: next, done: done, total: e.items.length,
      needsReview: creds.some(function (c) { return needsVerification(c, v); })
    };
  });
}

function api_volunteer(id) {
  requireAdmin_();
  var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', id);
  if (!v) throw new Error('No volunteer ' + id);
  var p = policy_();
  var today = today_();
  var creds = readRows_(TABS.CREDENTIALS).filter(function (c) { return c.VolunteerID === id; });
  var reqs = readRows_(TABS.REQUIREMENTS).filter(function (r) { return r.VolunteerID === id; });
  var e = evaluateEligibility(v, reqs, creds, today, { bgIntervalMonths: p.bgIntervalMonths });
  var required = {};
  e.items.forEach(function (i) { required[i.key] = i; });
  var defsOrder = REQUIREMENT_DEFS.map(function (d) { return d.key; });
  return {
    volunteer: publicRow_(v),
    eligibility: { eligible: e.eligible, reasons: e.reasons },
    attestationDue: isIsoDate(v.LastAttestationDate) ? addYears(v.LastAttestationDate, 1) : '',
    credentials: creds.map(function (c) {
      var t = CREDENTIAL_TYPES[c.Type] || {};
      return Object.assign(publicRow_(c), {
        board: t.board || '', lookupUrl: t.lookupUrl || '',
        verified: isVerified(c), needsVerification: needsVerification(c, v),
        superseded: isSuperseded(c, creds),
        expired: isIsoDate(c.ExpirationDate) && c.ExpirationDate < today
      });
    }),
    requirements: reqs.map(function (r) {
      var item = required[r.RequirementKey];
      var def = requirementDef(r.RequirementKey) || {};
      return Object.assign(publicRow_(r), {
        owner: def.owner || 'admin',
        applies: !!item,
        ok: item ? item.ok : false,
        computedStatus: item ? item.status : r.Status,
        reason: item ? item.reason : ''
      });
    }).sort(function (a, b) {
      return defsOrder.indexOf(a.RequirementKey) - defsOrder.indexOf(b.RequirementKey);
    })
  };
}

function api_createVolunteer(fields) {
  var actor = requireAdmin_();
  return createVolunteer_(fields, actor).VolunteerID;
}

function api_updateVolunteer(id, fields) {
  var actor = requireAdmin_();
  updateVolunteer_(id, fields, actor);
  return true;
}

function api_saveCredential(volunteerId, credentialId, fields, verifyNow) {
  var actor = requireAdmin_();
  saveCredential_(volunteerId, credentialId || '', fields, !!verifyNow, actor);
  return true;
}

function api_verifyCredential(credentialId, sourceDocUrl) {
  var actor = requireAdmin_();
  verifyCredential_(credentialId, sourceDocUrl, actor);
  return true;
}

function api_deleteCredential(credentialId) {
  var actor = requireAdmin_();
  deleteCredential_(credentialId, actor);
  return true;
}

function api_updateRequirement(requirementId, fields) {
  var actor = requireAdmin_();
  updateRequirement_(requirementId, fields, actor);
  return true;
}

function api_recordAttestation(volunteerId, date) {
  var actor = requireAdmin_();
  recordAttestation_(volunteerId, date, actor);
  return true;
}
