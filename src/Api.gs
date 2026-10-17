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
    blockIneligibleClaims: policy_().blockIneligibleClaims,
    portalReady: !!deployedUrls_().volunteerUrl
  };
}

function api_dashboard() {
  requireAdmin_();
  var p = policy_();
  var data = loadAll_();
  var docs = getDocuments_();
  data.signatures = readRows_(TABS.SIGNATURES);
  data.documents = docs;
  var d = buildDashboard(data, today_(), { reminderLeadDays: p.reminderLeadDays, bgIntervalMonths: p.bgIntervalMonths });
  d.sendUpdateRequests = p.sendUpdateRequests;
  d.missingDocuments = DOC_ORDER.filter(function (k) { return !docs[k]; })
    .map(function (k) { return DOC_DEFAULT_TITLES[k] + ' (' + k + ')'; });
  return d;
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
  var sigs = signaturesFor_(id);
  var docs = getDocuments_();
  var tasks = onboardingTasks(v, reqs, creds, sigs, docs, today, { attestationLeadDays: p.attestationLeadDays });
  var required = {};
  e.items.forEach(function (i) { required[i.key] = i; });
  var defsOrder = REQUIREMENT_DEFS.map(function (d) { return d.key; });
  return {
    volunteer: publicRow_(v),
    link: {
      issuedAt: v.TokenIssuedAt || '', revokedAt: v.TokenRevokedAt || '',
      active: !!(v.AccessToken && !v.TokenRevokedAt), invitedAt: v.InvitedAt || ''
    },
    tasks: tasks,
    signatures: sigs.map(function (s) {
      return {
        SignatureID: s.SignatureID, DocKey: s.DocKey, DocTitle: s.DocTitle, DocVersion: s.DocVersion,
        Kind: s.Kind, Status: s.Status, SignerName: s.SignerName, SignedAt: s.SignedAt,
        SupervisorName: s.SupervisorName, SupervisorEmail: s.SupervisorEmail, SupervisorSignedAt: s.SupervisorSignedAt,
        CountersignedBy: s.CountersignedBy, CountersignedAt: s.CountersignedAt, PdfUrl: s.PdfUrl,
        currentVersion: docs[s.DocKey] ? docs[s.DocKey].Version : ''
      };
    }),
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

// ---------------------------------------------------------------- Phase 2: onboarding

function api_invite(volunteerId) {
  var actor = requireAdmin_();
  return inviteVolunteer_(volunteerId, actor);
}

function api_bulkInvite(text, status) {
  var actor = requireAdmin_();
  return bulkInvite_(text, status, actor);
}

function api_revokeLink(volunteerId) {
  var actor = requireAdmin_();
  withLock_(function () {
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', volunteerId);
    if (!v) throw new Error('No volunteer ' + volunteerId);
    revokeToken_(v, actor);
  });
  return true;
}

/**
 * Files a document an admin already has (last year's signed agreement, a
 * background check authorization) into the volunteer's folder and completes
 * the requirement with it.
 */
function api_uploadRequirementDocument(requirementId, file, completedDate) {
  var actor = requireAdmin_();
  var upload = blobFromUpload_(file);
  if (completedDate && !isIsoDate(completedDate)) throw new Error('Choose the date it was signed.');
  var url = withLock_(function () {
    var r = findRow_(TABS.REQUIREMENTS, 'RequirementID', requirementId);
    if (!r) throw new Error('No requirement ' + requirementId);
    var def = requirementDef(r.RequirementKey);
    if (def && def.owner === 'system') throw new Error(r.Requirement + ' is calculated automatically.');
    // Spec §9: never store the background check report or any criminal history.
    if (r.RequirementKey === 'bg_determination') throw new Error('Background check reports are never stored. Record only the determination, date and reviewer.');
    if (r.RequirementKey === 'supervisor') throw new Error('Enter the supervisor\'s name instead.');
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', r.VolunteerID);
    var name = documentFileName(completedDate || today_(), v, r.Requirement, '', upload.ext);
    var saved = saveFile_(ensureVolunteerFolder_(v), name, upload.blob);
    logAudit_(actor, 'document.upload', 'Requirement', requirementId, r.VolunteerID + ' ' + r.RequirementKey + ': ' + name);
    return saved.url;
  });
  var r = findRow_(TABS.REQUIREMENTS, 'RequirementID', requirementId);
  updateRequirement_(requirementId, {
    DocumentUrl: url, Status: 'Complete', CompletedDate: completedDate || r.CompletedDate || today_()
  }, actor);
  return url;
}

/** Attaches the volunteer's capture or the admin's own board capture to a credential. */
function api_uploadCredentialDocument(credentialId, which, file) {
  var actor = requireAdmin_();
  if (which !== 'UploadedDocUrl' && which !== 'SourceDocUrl') throw new Error('Unknown attachment.');
  var upload = blobFromUpload_(file);
  var c = findRow_(TABS.CREDENTIALS, 'CredentialID', credentialId);
  if (!c) throw new Error('No credential ' + credentialId);
  var url = withLock_(function () {
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', c.VolunteerID);
    var label = c.Type + (which === 'SourceDocUrl' ? ' (board lookup capture)' : ' (copy)');
    var name = documentFileName(today_(), v, label, '', upload.ext);
    var saved = saveFile_(ensureVolunteerFolder_(v), name, upload.blob);
    logAudit_(actor, 'document.upload', 'Credential', credentialId, c.VolunteerID + ': ' + name);
    return saved.url;
  });
  var patch = {};
  patch[which] = url;
  saveCredential_(c.VolunteerID, credentialId, patch, false, actor);
  return url;
}

function api_countersign(signatureIds, input) {
  var actor = requireAdmin_();
  if (!signatureIds || !signatureIds.length) throw new Error('Nothing selected.');
  withLock_(function () { countersign_(signatureIds.map(String), input || {}, actor); });
  return true;
}

function api_shareFolders() {
  requireAdmin_();
  withLock_(function () { shareWithAdmins_(rootFolderId_()); });
  return folderUrl_(rootFolderId_());
}

/** Which documents are published in the Documents tab, for the Documents page. */
function api_documents() {
  requireAdmin_();
  var docs = getDocuments_();
  var sigs = readRows_(TABS.SIGNATURES);
  return DOC_ORDER.map(function (k) {
    var d = docs[k];
    return {
      key: k, published: !!d, title: d ? d.Title : '', version: d ? d.Version : '',
      effectiveDate: d ? d.EffectiveDate : '', kind: DOC_FORMS[k].kind,
      signedCount: sigs.filter(function (s) { return s.DocKey === k && s.Status === SIGNATURE_STATUS.COMPLETE; }).length,
      html: d ? renderBodyHtml(d.Body, {}) : ''
    };
  });
}

// ---------------------------------------------------------------- Phase 3: call calendar

/** One month of the call calendar, with names, counts against target and the calendar link. */
function api_calendar(month) {
  requireAdmin_();
  var today = today_();
  if (!isMonth(month)) month = today.slice(0, 7);
  var view = adminMonth(readRows_(TABS.VOLUNTEERS), readRows_(TABS.CALL_SHIFTS), month, today);
  var id = String(getSettings_().CallCalendarId || '').trim();
  view.calendarId = id;
  view.calendarName = '';
  try { var cal = id && callCalendar_(); if (cal) view.calendarName = cal.getName(); } catch (e) { view.calendarName = ''; }
  view.calendarUrl = id ? 'https://calendar.google.com/calendar/u/0/r?cid=' + encodeURIComponent(id) : '';
  view.startTime = shiftStartTime_();
  view.today = today;
  return view;
}

function api_assignShift(date, volunteerId, month) {
  var actor = requireAdmin_();
  withLock_(function () { claimShift_(String(volunteerId), String(date), actor, { byAdmin: true, source: 'admin', invite: true }); });
  return api_calendar(month);
}

function api_unassignShift(date, month) {
  var actor = requireAdmin_();
  withLock_(function () { releaseShift_('', String(date), actor, true); });
  return api_calendar(month);
}

/** Creates the HFJ On Call calendar if needed and adds any events that failed to sync. */
function api_syncCalendar(month) {
  requireAdmin_(); // runs as volunteers@, so this is where the calendar is first created
  withLock_(function () { ensureCallCalendar_(); syncMissingEvents_(); });
  return api_calendar(month);
}

/** Uses an existing HFJ Google Calendar for call days instead of creating HFJ On Call. */
function api_useCalendar(calendarId, month) {
  var actor = requireAdmin_();
  withLock_(function () { useCallCalendar_(calendarId, actor); });
  return api_calendar(month);
}

/** Reads an existing call calendar and matches its events to volunteers, without saving anything. */
function api_importPreview(calendarId, from, to) {
  requireAdmin_();
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) throw new Error('Choose a date range.');
  if (daysBetween(from, to) > 400) throw new Error('Import at most about a year at a time.');
  var events = readExternalCalendar_(calendarId, from, to);
  var volunteers = readRows_(TABS.VOLUNTEERS);
  return {
    // Importing from the call calendar itself links its events rather than copying them.
    linked: String(calendarId || '').trim() === String(getSettings_().CallCalendarId || '').trim(),
    rows: matchImportEvents(events, volunteers, activeShiftsByDate(readRows_(TABS.CALL_SHIFTS))),
    people: volunteers.filter(function (v) { return takesCall(v) && v.Status !== 'Departed'; })
      .map(function (v) { return { volunteerId: v.VolunteerID, name: v.Name }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : 1; })
  };
}

/**
 * Saves previewed rows [{ date, volunteerId, eventId }] as claims. invite: also
 * add each volunteer as a guest of new events. When calendarId is the call
 * calendar itself, each row's existing event is linked (claimShift_ checks it's
 * really on that calendar) instead of adding a copy.
 */
function api_importShifts(rows, invite, calendarId) {
  var actor = requireAdmin_();
  var linked = !!calendarId && String(calendarId).trim() === String(getSettings_().CallCalendarId || '').trim();
  var result = { imported: 0, skipped: [] };
  (rows || []).slice(0, 400).forEach(function (r) {
    if (!r || !r.volunteerId) return;
    try {
      withLock_(function () {
        claimShift_(String(r.volunteerId), String(r.date), actor,
          { byAdmin: true, source: 'import', invite: !!invite, eventId: linked && r.eventId ? String(r.eventId) : '' });
      });
      result.imported++;
    } catch (e) {
      result.skipped.push(r.date + ': ' + e.message);
    }
  });
  logAudit_(actor, 'shift.import', 'CallShift', '', result.imported + ' imported, ' + result.skipped.length + ' skipped');
  return result;
}
