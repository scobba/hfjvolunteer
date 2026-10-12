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
