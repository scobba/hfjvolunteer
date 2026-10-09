/**
 * Roster operations: volunteers, their credentials and requirement rows.
 * Every write runs under the script lock and lands in AuditLog.
 */

var EDITABLE_VOLUNTEER_FIELDS = ['Name', 'PreferredName', 'Credential', 'Email', 'Phone',
  'SpanishFluency', 'Notes', 'Status', 'CallTargetPerMonth', 'OnSignal', 'Telehealth',
  'Precepting', 'DriveFolderUrl', 'StartDate', 'LastAttestationDate'];

var EDITABLE_CREDENTIAL_FIELDS = ['Type', 'LicenseNumber', 'IssuingState', 'ExpirationDate',
  'UploadedDocUrl', 'SourceDocUrl', 'Notes'];

/** Changing any of these on a verified credential means it must be verified again. */
var REVERIFY_FIELDS = ['Type', 'LicenseNumber', 'IssuingState', 'ExpirationDate'];

function loadAll_() {
  return {
    volunteers: readRows_(TABS.VOLUNTEERS),
    credentials: readRows_(TABS.CREDENTIALS),
    requirements: readRows_(TABS.REQUIREMENTS),
    shifts: readRows_(TABS.CALL_SHIFTS)
  };
}

function pick_(obj, fields) {
  var out = {};
  fields.forEach(function (f) { if (obj && f in obj) out[f] = obj[f]; });
  return out;
}

function cleanVolunteerFields_(f) {
  var out = pick_(f, EDITABLE_VOLUNTEER_FIELDS);
  ['Name', 'PreferredName', 'Email', 'Phone', 'SpanishFluency', 'DriveFolderUrl'].forEach(function (k) {
    if (k in out) out[k] = String(out[k] || '').trim();
  });
  if ('Email' in out) out.Email = out.Email.toLowerCase();
  if ('Status' in out && VOLUNTEER_STATUSES.indexOf(out.Status) === -1) throw new Error('Unknown status ' + out.Status);
  if ('CallTargetPerMonth' in out && (out.CallTargetPerMonth === undefined || out.CallTargetPerMonth === null)) {
    out.CallTargetPerMonth = '';
  }
  if ('CallTargetPerMonth' in out && out.CallTargetPerMonth !== '') {
    var n = Number(out.CallTargetPerMonth);
    if (!(n >= 0 && n === Math.floor(n))) throw new Error('Call target must be a whole number.');
    out.CallTargetPerMonth = n;
  }
  ['StartDate', 'LastAttestationDate'].forEach(function (k) {
    if (k in out && out[k] && !isIsoDate(out[k])) throw new Error(k + ' must be a date.');
  });
  return out;
}

/**
 * Creates a volunteer and their requirement rows.
 * opts.allowUnknownCredential: the migration may import someone whose
 * credential needs setting by hand; the admin UI may not.
 */
function createVolunteer_(fields, actor, opts) {
  opts = opts || {};
  var f = cleanVolunteerFields_(fields);
  if (!f.Name) throw new Error('Name is required.');
  if (!opts.allowUnknownCredential && !credentialInfo(f.Credential)) throw new Error('Choose a credential.');
  return withLock_(function () {
    if (f.Email && findRow_(TABS.VOLUNTEERS, 'Email', f.Email)) {
      throw new Error('A volunteer with email ' + f.Email + ' already exists.');
    }
    var now = new Date();
    var v = Object.assign({
      Status: 'Prospective', OnSignal: false, Telehealth: false, Precepting: false
    }, f, {
      VolunteerID: nextId_(TABS.VOLUNTEERS, 'VolunteerID', 'HFJV-'),
      Category: categoryForCredential(f.Credential) || fields.Category || '',
      CreatedAt: now, CreatedBy: actor.email, UpdatedAt: now, UpdatedBy: actor.email
    });
    v._row = appendRow_(TABS.VOLUNTEERS, v);
    syncRequirements_(v, actor);
    logAudit_(actor, 'volunteer.create', 'Volunteer', v.VolunteerID,
      (opts.source ? opts.source + ': ' : '') + v.Name + ' (' + (v.Credential || 'no credential') + ', ' + v.Status + ')');
    return v;
  });
}

function updateVolunteer_(id, fields, actor) {
  var patch = cleanVolunteerFields_(fields);
  if ('Name' in patch && !patch.Name) throw new Error('Name is required.');
  if ('Credential' in patch && !credentialInfo(patch.Credential)) throw new Error('Choose a credential.');
  return withLock_(function () {
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', id);
    if (!v) throw new Error('No volunteer ' + id);
    if (patch.Email && patch.Email !== v.Email) {
      var clash = findRow_(TABS.VOLUNTEERS, 'Email', patch.Email);
      if (clash && clash.VolunteerID !== id) throw new Error('Email already used by ' + clash.Name + '.');
    }
    var changes = describeChanges_(v, patch, EDITABLE_VOLUNTEER_FIELDS);
    if ('Credential' in patch) patch.Category = categoryForCredential(patch.Credential);
    patch.UpdatedAt = new Date();
    patch.UpdatedBy = actor.email;
    updateRow_(TABS.VOLUNTEERS, v._row, patch);
    var updated = Object.assign({}, v, patch);
    if ('Credential' in patch || 'Telehealth' in patch || 'Precepting' in patch) syncRequirements_(updated, actor);
    if (changes) logAudit_(actor, 'volunteer.update', 'Volunteer', id, changes);
    afterChange_(id, actor);
    return updated;
  });
}

/**
 * Brings a volunteer's Requirements rows in line with the matrix: adds
 * missing items, and removes items that no longer apply but were never
 * started. Started/completed items that no longer apply are kept for the
 * record (they're ignored by eligibility). Call inside withLock_.
 */
function syncRequirements_(v, actor) {
  var defs = requiredDefsFor(v) || [];
  var info = credentialInfo(v.Credential);
  var wanted = {};
  defs.forEach(function (d) { wanted[d.key] = d; });
  var rows = readRows_(TABS.REQUIREMENTS).filter(function (r) { return r.VolunteerID === v.VolunteerID; });
  var have = {};
  var now = new Date();

  // Delete bottom-up so row numbers stay valid.
  rows.slice().sort(function (a, b) { return b._row - a._row; }).forEach(function (r) {
    if (!wanted[r.RequirementKey] && (r.Status || 'Not started') === 'Not started' && !r.CompletedDate) {
      deleteRow_(TABS.REQUIREMENTS, r._row);
    } else {
      have[r.RequirementKey] = true;
    }
  });

  var next = +nextId_(TABS.REQUIREMENTS, 'RequirementID', 'REQ-').slice(4);
  defs.forEach(function (d) {
    if (have[d.key]) return;
    appendRow_(TABS.REQUIREMENTS, {
      RequirementID: 'REQ-' + ('00000' + next++).slice(-5),
      VolunteerID: v.VolunteerID, RequirementKey: d.key,
      Requirement: requirementLabel(d, info.group), Status: 'Not started',
      Notes: d.note || '', UpdatedAt: now, UpdatedBy: actor.email
    });
  });
}

function cleanCredentialFields_(f) {
  var out = pick_(f, EDITABLE_CREDENTIAL_FIELDS);
  Object.keys(out).forEach(function (k) { out[k] = String(out[k] || '').trim(); });
  if ('Type' in out && !CREDENTIAL_TYPES[out.Type]) throw new Error('Choose a credential type.');
  if (out.ExpirationDate && !isIsoDate(out.ExpirationDate)) throw new Error('Expiration must be a date.');
  if ('IssuingState' in out) out.IssuingState = out.IssuingState.toUpperCase();
  return out;
}

/**
 * Adds or edits a credential. `verifyNow` records that the acting admin
 * checked it against the board's primary source as part of this save.
 */
function saveCredential_(volunteerId, credentialId, fields, verifyNow, actor) {
  var f = cleanCredentialFields_(fields);
  return withLock_(function () {
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', volunteerId);
    if (!v) throw new Error('No volunteer ' + volunteerId);
    var now = new Date();
    var c;
    if (credentialId) {
      c = findRow_(TABS.CREDENTIALS, 'CredentialID', credentialId);
      if (!c || c.VolunteerID !== volunteerId) throw new Error('No credential ' + credentialId);
      if (verifyNow && !isIsoDate('ExpirationDate' in f ? f.ExpirationDate : c.ExpirationDate)) {
        throw new Error('Record the expiration date before verifying.');
      }
      var changes = describeChanges_(c, f, EDITABLE_CREDENTIAL_FIELDS);
      var patch = Object.assign({}, f, { UpdatedAt: now, UpdatedBy: actor.email });
      if (isVerified(c) && describeChanges_(c, f, REVERIFY_FIELDS)) {
        patch.VerifiedBy = ''; patch.VerifiedDate = ''; patch.VerificationMethod = '';
        changes += '; verification cleared — re-verify';
      }
      if (verifyNow) Object.assign(patch, verificationFields_(actor));
      updateRow_(TABS.CREDENTIALS, c._row, patch);
      logAudit_(actor, 'credential.update', 'Credential', credentialId, volunteerId + ': ' + changes);
      c = Object.assign(c, patch);
    } else {
      if (!f.Type) throw new Error('Choose a credential type.');
      if (verifyNow && !isIsoDate(f.ExpirationDate)) throw new Error('Record the expiration date before verifying.');
      c = Object.assign({ IssuingState: 'CA' }, f, {
        CredentialID: nextId_(TABS.CREDENTIALS, 'CredentialID', 'CRED-'),
        VolunteerID: volunteerId, CreatedAt: now, CreatedBy: actor.email,
        UpdatedAt: now, UpdatedBy: actor.email
      }, verifyNow ? verificationFields_(actor) : {});
      appendRow_(TABS.CREDENTIALS, c);
      logAudit_(actor, 'credential.create', 'Credential', c.CredentialID,
        volunteerId + ': ' + c.Type + ' ' + (c.LicenseNumber || '') + ' exp ' + (c.ExpirationDate || '?'));
    }
    if (verifyNow) logVerification_(actor, c);
    afterChange_(volunteerId, actor);
    return c;
  });
}

function verificationFields_(actor) {
  return { VerifiedBy: actor.name, VerifiedDate: today_(), VerificationMethod: 'manual' };
}

function logVerification_(actor, c) {
  logAudit_(actor, 'credential.verify', 'Credential', c.CredentialID,
    'Verified against primary source by ' + actor.name + ' on ' + today_() +
    (c.SourceDocUrl ? ' (capture: ' + c.SourceDocUrl + ')' : ''));
}

/** One-click verification from the review screen (spec §5.3). */
function verifyCredential_(credentialId, sourceDocUrl, actor) {
  return withLock_(function () {
    var c = findRow_(TABS.CREDENTIALS, 'CredentialID', credentialId);
    if (!c) throw new Error('No credential ' + credentialId);
    if (!isIsoDate(c.ExpirationDate)) throw new Error('Record the expiration date before verifying.');
    var patch = Object.assign(verificationFields_(actor), { UpdatedAt: new Date(), UpdatedBy: actor.email });
    if (sourceDocUrl) patch.SourceDocUrl = String(sourceDocUrl).trim();
    updateRow_(TABS.CREDENTIALS, c._row, patch);
    c = Object.assign(c, patch);
    logVerification_(actor, c);
    afterChange_(c.VolunteerID, actor);
    return c;
  });
}

function deleteCredential_(credentialId, actor) {
  return withLock_(function () {
    var c = findRow_(TABS.CREDENTIALS, 'CredentialID', credentialId);
    if (!c) throw new Error('No credential ' + credentialId);
    deleteRow_(TABS.CREDENTIALS, c._row);
    logAudit_(actor, 'credential.delete', 'Credential', credentialId,
      c.VolunteerID + ': ' + c.Type + ' ' + (c.LicenseNumber || '') + ' exp ' + (c.ExpirationDate || '?'));
    afterChange_(c.VolunteerID, actor);
  });
}

/**
 * Admin update of a manual requirement. System items (license, attestation)
 * are computed and can't be set by hand. A background check determination
 * stores only the outcome, date and reviewer — never the report.
 */
function updateRequirement_(requirementId, fields, actor) {
  return withLock_(function () {
    var r = findRow_(TABS.REQUIREMENTS, 'RequirementID', requirementId);
    if (!r) throw new Error('No requirement ' + requirementId);
    var def = requirementDef(r.RequirementKey);
    if (def && def.owner === 'system') throw new Error(r.Requirement + ' is calculated automatically.');
    var patch = pick_(fields, ['Status', 'CompletedDate', 'DocumentUrl', 'Detail', 'Notes']);
    Object.keys(patch).forEach(function (k) { patch[k] = String(patch[k] || '').trim(); });
    if ('Status' in patch && REQUIREMENT_STATUSES.indexOf(patch.Status) === -1) throw new Error('Unknown status.');
    if (patch.CompletedDate && !isIsoDate(patch.CompletedDate)) throw new Error('Completed date must be a date.');
    var status = 'Status' in patch ? patch.Status : r.Status;
    if (r.RequirementKey === 'bg_determination' && status === 'Complete') {
      var det = 'Detail' in patch ? patch.Detail : r.Detail;
      if (BACKGROUND_DETERMINATIONS.indexOf(det) === -1) {
        throw new Error('Choose Cleared, Conditional or Not cleared.');
      }
    }
    if (r.RequirementKey === 'supervisor' && status === 'Complete' && !('Detail' in patch ? patch.Detail : r.Detail)) {
      throw new Error('Enter the supervisor\'s name.');
    }
    if (status === 'Complete') {
      if (!patch.CompletedDate && !r.CompletedDate) patch.CompletedDate = today_();
      if (r.Status !== 'Complete' || !r.CompletedBy || r.CompletedBy === 'Migration') patch.CompletedBy = actor.name;
    } else if ('Status' in patch && r.Status === 'Complete') {
      patch.CompletedDate = ''; patch.CompletedBy = '';
    }
    patch.UpdatedAt = new Date();
    patch.UpdatedBy = actor.email;
    var changes = describeChanges_(r, patch, ['Status', 'CompletedDate', 'CompletedBy', 'DocumentUrl', 'Detail', 'Notes']);
    updateRow_(TABS.REQUIREMENTS, r._row, patch);
    if (changes) logAudit_(actor, 'requirement.update', 'Requirement', requirementId, r.VolunteerID + ' ' + r.RequirementKey + ': ' + changes);
    afterChange_(r.VolunteerID, actor);
    return Object.assign(r, patch);
  });
}

/**
 * After any change: refresh the stored status of computed items so the sheet
 * reads true, and promote a Prospective volunteer to Active once everything
 * is complete (spec §9). Call inside withLock_.
 */
function afterChange_(volunteerId, actor) {
  var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', volunteerId);
  if (!v) return;
  var data = loadAll_();
  var reqs = data.requirements.filter(function (r) { return r.VolunteerID === volunteerId; });
  var creds = data.credentials.filter(function (c) { return c.VolunteerID === volunteerId; });
  var e = evaluateEligibility(v, reqs, creds, today_(), { bgIntervalMonths: policy_().bgIntervalMonths, ignoreStatus: true });
  writeComputedStatuses_(e, actor);
  if (v.Status === 'Prospective' && e.eligible) {
    updateRow_(TABS.VOLUNTEERS, v._row, { Status: 'Active', UpdatedAt: new Date(), UpdatedBy: actor.email });
    logAudit_(actor, 'volunteer.activate', 'Volunteer', volunteerId, 'All requirements complete: Prospective → Active');
  }
}

/** Writes computed statuses (license, attestation, background recheck) back to Requirements. */
function writeComputedStatuses_(evaluation, actor) {
  evaluation.items.forEach(function (item) {
    var computed = item.owner === 'system' || item.key === 'bg_determination';
    if (!computed || !item.row) return;
    var status = item.key === 'bg_determination' && item.status !== 'Expired' ? item.row.Status : item.status;
    var note = item.owner === 'system' ? (item.reason || '') : item.row.Notes;
    if (item.row.Status === status && (item.owner !== 'system' || item.row.Notes === note)) return;
    var patch = { Status: status, UpdatedAt: new Date(), UpdatedBy: actor.email || 'system' };
    if (item.owner === 'system') patch.Notes = note;
    updateRow_(TABS.REQUIREMENTS, item.row._row, patch);
    if (item.row.Status !== status) {
      logAudit_(actor, 'requirement.status', 'Requirement', item.row.RequirementID,
        item.row.VolunteerID + ' ' + item.key + ': ' + (item.row.Status || '') + ' → ' + status);
    }
  });
}

function recordAttestation_(volunteerId, date, actor) {
  if (!isIsoDate(date)) throw new Error('Choose the attestation date.');
  return updateVolunteer_(volunteerId, { LastAttestationDate: date }, actor);
}
