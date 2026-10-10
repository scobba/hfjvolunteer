/**
 * The volunteer portal behind each personal link, and the supervisor signing
 * page. Every call resolves the volunteer from the token on the server and
 * acts only on that volunteer's own record. Each use is logged.
 */

var PORTAL_PROFILE_FIELDS = ['PreferredName', 'Phone', 'SpanishFluency', 'CallTargetPerMonth', 'OnSignal'];
var PORTAL_CREDENTIAL_FIELDS = ['Type', 'LicenseNumber', 'IssuingState', 'ExpirationDate'];

function portalVolunteer_(token, action) {
  var v = volunteerByToken_(token);
  if (!v) throw new Error('This link is no longer valid. Please ask HFJ for a new one.');
  logAudit_(volunteerActor_(v), 'portal.' + action, 'Volunteer', v.VolunteerID, '');
  return v;
}

function portal_bootstrap(token) {
  return withLock_(function () {
    var v = portalVolunteer_(token, 'open');
    ensureVolunteerFolder_(v);
    return portalState_(v);
  });
}

function portalState_(v) {
  var today = today_();
  var creds = readRows_(TABS.CREDENTIALS).filter(function (c) { return c.VolunteerID === v.VolunteerID; });
  var reqs = readRows_(TABS.REQUIREMENTS).filter(function (r) { return r.VolunteerID === v.VolunteerID; });
  var sigs = signaturesFor_(v.VolunteerID);
  var docs = getDocuments_();
  var tasks = onboardingTasks(v, reqs, creds, sigs, docs, today, { attestationLeadDays: policy_().attestationLeadDays });
  var forms = {};
  tasks.forEach(function (t) {
    if (!t.docKey || !docs[t.docKey]) return;
    var fields = formFieldsFor(t.docKey, v).map(function (f) {
      return { key: f.key, label: f.label, type: f.type || 'text', required: !!f.required, value: prefillValue(f, v, creds) };
    });
    var preview = { Name: v.Name, Date: today };
    fields.forEach(function (f) { preview[f.key] = f.value; });
    forms[t.docKey] = {
      title: docs[t.docKey].Title, version: docs[t.docKey].Version, effectiveDate: docs[t.docKey].EffectiveDate,
      kind: DOC_FORMS[t.docKey].kind, ackLabel: DOC_FORMS[t.docKey].ackLabel || '',
      html: renderBodyHtml(docs[t.docKey].Body, preview), fields: fields,
      sensitive: !!DOC_FORMS[t.docKey].sensitive
    };
  });
  return {
    volunteer: {
      VolunteerID: v.VolunteerID, Name: v.Name, PreferredName: v.PreferredName, Email: v.Email,
      Phone: v.Phone, SpanishFluency: v.SpanishFluency, CallTargetPerMonth: v.CallTargetPerMonth,
      OnSignal: v.OnSignal, Credential: v.Credential, Status: v.Status
    },
    tasks: tasks,
    forms: forms,
    credentials: creds.map(function (c) {
      return { CredentialID: c.CredentialID, Type: c.Type, LicenseNumber: c.LicenseNumber, IssuingState: c.IssuingState,
        ExpirationDate: c.ExpirationDate, uploaded: !!c.UploadedDocUrl, verified: isVerified(c) };
    }),
    credentialTypes: Object.keys(CREDENTIAL_TYPES),
    // Where volunteers look themselves up to make the copy they upload.
    lookups: Object.keys(CREDENTIAL_TYPES).reduce(function (m, t) {
      if (/^https:\/\//.test(CREDENTIAL_TYPES[t].lookupUrl)) m[t] = { board: CREDENTIAL_TYPES[t].board, url: CREDENTIAL_TYPES[t].lookupUrl };
      return m;
    }, {}),
    done: volunteerPartComplete(tasks)
  };
}

function portal_saveProfile(token, fields) {
  return withLock_(function () {
    var v = portalVolunteer_(token, 'profile');
    var patch = pick_(fields, PORTAL_PROFILE_FIELDS);
    var clean = cleanVolunteerFields_(patch);
    if (!String(clean.Phone || v.Phone || '').trim()) throw new Error('Please enter a phone number.');
    var actor = volunteerActor_(v);
    var changes = describeChanges_(v, clean, PORTAL_PROFILE_FIELDS);
    clean.ProfileConfirmedAt = new Date();
    clean.UpdatedAt = new Date();
    clean.UpdatedBy = actor.email;
    updateRow_(TABS.VOLUNTEERS, v._row, clean);
    logAudit_(actor, 'volunteer.update', 'Volunteer', v.VolunteerID, 'Profile confirmed' + (changes ? ': ' + changes : ''));
    return portalState_(findRow_(TABS.VOLUNTEERS, 'VolunteerID', v.VolunteerID));
  });
}

/**
 * Adds or renews a license. The upload is the volunteer's own capture: supporting
 * documentation, never the verification itself (spec §5). Admins are told at once.
 */
function portal_saveCredential(token, fields, file) {
  var v = withLock_(function () { return portalVolunteer_(token, 'credential'); });
  var f = pick_(fields, PORTAL_CREDENTIAL_FIELDS);
  if (!CREDENTIAL_TYPES[f.Type]) throw new Error('Choose the credential type.');
  if (!String(f.LicenseNumber || '').trim()) throw new Error('Enter the license or certificate number.');
  if (!isIsoDate(f.ExpirationDate)) throw new Error('Enter the expiration date.');
  if (f.ExpirationDate < today_()) throw new Error('That expiration date has passed. Please enter your current license.');
  var upload = file ? blobFromUpload_(file) : null;

  var mine = readRows_(TABS.CREDENTIALS).filter(function (c) { return c.VolunteerID === v.VolunteerID && c.Type === f.Type; });
  // Edit an unverified entry in place; a renewal of a verified one becomes a new row so history is kept.
  var target = mine.filter(function (c) { return !isVerified(c) && !isSuperseded(c, mine); })[0];
  if (!upload && !(target && target.UploadedDocUrl)) throw new Error('Please attach a copy of your license (a screenshot or PDF from the board website).');

  if (upload) {
    f.UploadedDocUrl = withLock_(function () {
      var fresh = findRow_(TABS.VOLUNTEERS, 'VolunteerID', v.VolunteerID);
      var name = documentFileName(today_(), fresh, f.Type + ' (volunteer upload)', '', upload.ext);
      return saveFile_(ensureVolunteerFolder_(fresh), name, upload.blob).url;
    });
  }
  // saveCredential_ takes the lock itself, verifies nothing, and re-checks eligibility.
  var saved = saveCredential_(v.VolunteerID, target ? target.CredentialID : '', f, false, volunteerActor_(v));
  var t = CREDENTIAL_TYPES[saved.Type] || {};
  notifyAdmins_('Verify: ' + saved.Type + ' for ' + v.Name, [
    v.Name + ' (' + v.VolunteerID + ') entered a ' + saved.Type + '.',
    'Number: ' + (saved.LicenseNumber || '') + ' · Expires: ' + (saved.ExpirationDate || ''),
    t.lookupUrl ? 'Look it up at ' + t.board + ': ' + t.lookupUrl : '',
    'Their upload: ' + (saved.UploadedDocUrl || '(none)')
  ].filter(String));
  return withLock_(function () { return portalState_(findRow_(TABS.VOLUNTEERS, 'VolunteerID', v.VolunteerID)); });
}

function portal_acknowledge(token, docKey) {
  return withLock_(function () {
    var v = portalVolunteer_(token, 'acknowledge');
    acknowledgeDocument_(v, String(docKey));
    return portalState_(findRow_(TABS.VOLUNTEERS, 'VolunteerID', v.VolunteerID));
  });
}

function portal_sign(token, docKey, input) {
  return withLock_(function () {
    var v = portalVolunteer_(token, 'sign');
    // Re-signing an updated document isn't onboarding; don't tell admins it finished.
    var updateOnly = portalState_(v).tasks.every(function (t) { return t.status !== 'todo' || t.outdated; });
    signDocument_(v, String(docKey), input || {});
    var fresh = findRow_(TABS.VOLUNTEERS, 'VolunteerID', v.VolunteerID);
    var state = portalState_(fresh);
    if (state.done && !updateOnly) notifyVolunteerPartDone_(fresh, state.tasks);
    return state;
  });
}

function notifyVolunteerPartDone_(v, tasks) {
  var key = 'portal-done|' + v.VolunteerID + '|' + today_();
  if (readRows_(TABS.REMINDER_LOG).some(function (r) { return r.Key === key; })) return;
  appendRow_(TABS.REMINDER_LOG, { Key: key, LastSentAt: new Date(), SendCount: 1 });
  var open = tasks.filter(function (t) { return t.status === 'waiting' || t.status === 'hfj'; })
    .map(function (t) { return '- ' + t.title + (t.note ? ' (' + t.note + ')' : ''); });
  notifyAdmins_(v.Name + ' finished their part of onboarding',
    [v.Name + ' (' + v.VolunteerID + ') has completed everything they can do. Still open:'].concat(open));
}

// ---------------------------------------------------------------- supervisor page

function supervisor_bootstrap(token) {
  var s = signatureBySupervisorToken_(token);
  if (!s) throw new Error('This signing link is no longer valid. It may already have been used.');
  var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', s.VolunteerID);
  var values = s.FieldsJson ? JSON.parse(s.FieldsJson) : { Name: v.Name };
  logAudit_('supervisor:' + s.SupervisorEmail, 'portal.supervisorOpen', 'Signature', s.SignatureID, '');
  return {
    traineeName: v.Name, title: s.DocTitle, version: s.DocVersion,
    supervisorName: s.SupervisorName, html: renderBodyHtml(s.DocBody, values),
    traineeSignedAt: Utilities.formatDate(new Date(s.SignedAt), getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd')
  };
}

function supervisor_sign(token, input) {
  return withLock_(function () {
    supervisorSign_(token, input || {});
    return true;
  });
}
