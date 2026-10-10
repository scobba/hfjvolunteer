/**
 * Acknowledging and signing documents (spec §9).
 *
 * Flow for one document:
 *   volunteer signs ─► (BH trainee) supervisor signs via emailed link
 *                   ─► (agreements) an HFJ admin countersigns
 *                   ─► PDF with every signature is filed in the volunteer's
 *                      folder and the requirement(s) it covers are completed.
 *
 * The signed text is snapshotted (DocBody) when the volunteer signs, so the
 * final PDF matches what they saw even if the Documents tab changes later.
 * All functions here expect to run inside withLock_.
 */

var SIGNATURE_IMAGE_MAX = 45000;

function getDocuments_() {
  var out = {};
  readRows_(TABS.DOCUMENTS).forEach(function (d) {
    var key = String(d.DocKey || '').trim();
    if (key && DOC_FORMS[key] && String(d.Body || '').trim()) out[key] = d;
  });
  return out;
}

function signaturesFor_(volunteerId) {
  return readRows_(TABS.SIGNATURES).filter(function (s) { return s.VolunteerID === volunteerId; });
}

function stampNow_() {
  return Utilities.formatDate(new Date(), getSpreadsheet_().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm z');
}

function checkSignatureInput_(input) {
  if (!input || input.consent !== true) throw new Error('Please confirm that you agree to sign electronically.');
  var typed = String(input.typedName || '').trim();
  if (typed.length < 2) throw new Error('Please type your full name.');
  var img = String(input.image || '');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(img)) throw new Error('Please draw your signature.');
  if (img.length > SIGNATURE_IMAGE_MAX) throw new Error('That signature is too detailed to save. Please clear it and sign again.');
  return { typedName: typed.slice(0, 120), image: img };
}

function acknowledgeDocument_(v, docKey) {
  var form = DOC_FORMS[docKey];
  if (!form || form.kind !== 'ack') throw new Error('Unknown document.');
  if (documentsFor(v).indexOf(docKey) === -1) throw new Error('This document doesn\'t apply to you.');
  var doc = getDocuments_()[docKey];
  if (!doc) throw new Error('This document isn\'t available yet.');
  var existing = signaturesFor_(v.VolunteerID).filter(function (s) {
    return s.DocKey === docKey && s.DocVersion === doc.Version && s.Status === SIGNATURE_STATUS.COMPLETE;
  })[0];
  if (existing) return existing;
  var row = {
    SignatureID: nextId_(TABS.SIGNATURES, 'SignatureID', 'SIG-'), VolunteerID: v.VolunteerID,
    DocKey: docKey, DocTitle: doc.Title, DocVersion: doc.Version, Kind: 'ack',
    Status: SIGNATURE_STATUS.COMPLETE, SignerName: v.Name, SignedAt: new Date(), UpdatedAt: new Date()
  };
  appendRow_(TABS.SIGNATURES, row);
  logAudit_(volunteerActor_(v), 'document.acknowledge', 'Signature', row.SignatureID, doc.Title + ' v' + doc.Version);
  completeSatisfiedRequirements_(v);
  return row;
}

function signDocument_(v, docKey, input) {
  var form = DOC_FORMS[docKey];
  if (!form || form.kind !== 'sign') throw new Error('Unknown document.');
  if (documentsFor(v).indexOf(docKey) === -1) throw new Error('This document doesn\'t apply to you.');
  var doc = getDocuments_()[docKey];
  if (!doc) throw new Error('This document isn\'t available yet.');

  var open = signaturesFor_(v.VolunteerID).filter(function (s) { return s.DocKey === docKey && s.Kind === 'sign'; });
  if (form.attestation) {
    var due = isIsoDate(v.LastAttestationDate) ? addYears(v.LastAttestationDate, 1) : '';
    if (due && daysBetween(today_(), due) > policy_().attestationLeadDays) throw new Error('Your attestation isn\'t due yet.');
  } else if (open.some(function (s) { return s.DocVersion === doc.Version; })) {
    throw new Error('You have already signed this document.');
  }

  var sig = checkSignatureInput_(input);
  var cleaned = cleanFormValues(docKey, v, input.fields);
  if (cleaned.errors.length) throw new Error(cleaned.errors.join(' '));
  var values = Object.assign({ Name: v.Name, Date: today_() }, cleaned.values);
  var supervisor = needsSupervisorSignature(docKey, v);
  var status = supervisor ? SIGNATURE_STATUS.AWAITING_SUPERVISOR
    : form.countersign ? SIGNATURE_STATUS.AWAITING_HFJ : SIGNATURE_STATUS.COMPLETE;

  var row = {
    SignatureID: nextId_(TABS.SIGNATURES, 'SignatureID', 'SIG-'), VolunteerID: v.VolunteerID,
    DocKey: docKey, DocTitle: doc.Title, DocVersion: doc.Version, DocBody: doc.Body, Kind: 'sign', Status: status,
    SignerName: sig.typedName, SignedAt: new Date(), SignerImage: sig.image,
    FieldsJson: form.sensitive ? '' : JSON.stringify(values), UpdatedAt: new Date()
  };
  row.SignedAtText = stampNow_();

  var token = '';
  if (supervisor) {
    token = newToken_();
    row.SupervisorName = values.SupervisingClinician;
    row.SupervisorEmail = values.SupervisorEmail.toLowerCase();
    row.SupervisorTokenHash = hashToken_(token);
  }

  if (status === SIGNATURE_STATUS.COMPLETE) {
    // Sensitive answers exist only here, in memory, on their way into the PDF.
    fileSignedPdf_(row, v, doc, values);
  }
  delete row.SignedAtText;
  appendRow_(TABS.SIGNATURES, row);
  logAudit_(volunteerActor_(v), 'document.sign', 'Signature', row.SignatureID, doc.Title + ' v' + doc.Version + ' → ' + status);

  if (form.attestation) {
    var vrow = findRow_(TABS.VOLUNTEERS, 'VolunteerID', v.VolunteerID);
    updateRow_(TABS.VOLUNTEERS, vrow._row, { LastAttestationDate: today_(), UpdatedAt: new Date(), UpdatedBy: volunteerActor_(v).email });
    logAudit_(volunteerActor_(v), 'volunteer.attest', 'Volunteer', v.VolunteerID, 'Annual attestation signed');
  }
  if (supervisor) {
    emailSupervisor_(row.SupervisorName, row.SupervisorEmail, v, doc.Title, portalUrl_('s', token));
  } else if (status === SIGNATURE_STATUS.AWAITING_HFJ) {
    notifyAdmins_('Countersign: ' + doc.Title + ' for ' + v.Name,
      [v.Name + ' (' + v.VolunteerID + ') signed the ' + doc.Title + '. It needs an HFJ countersignature.']);
  }
  completeSatisfiedRequirements_(v);
  return row;
}

/** The signature row a supervisor's link belongs to, or null. */
function signatureBySupervisorToken_(token) {
  if (!isTokenShaped(token)) return null;
  var hash = hashToken_(token);
  return readRows_(TABS.SIGNATURES).filter(function (s) {
    return s.SupervisorTokenHash === hash && s.Status === SIGNATURE_STATUS.AWAITING_SUPERVISOR;
  })[0] || null;
}

function supervisorSign_(token, input) {
  var s = signatureBySupervisorToken_(token);
  if (!s) throw new Error('This signing link is no longer valid. It may already have been used.');
  var sig = checkSignatureInput_(input);
  var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', s.VolunteerID);
  updateRow_(TABS.SIGNATURES, s._row, {
    SupervisorName: sig.typedName, SupervisorSignedAt: new Date(), SupervisorImage: sig.image,
    SupervisorTokenHash: '', Status: SIGNATURE_STATUS.AWAITING_HFJ, UpdatedAt: new Date()
  });
  logAudit_('supervisor:' + s.SupervisorEmail, 'document.supervisorSign', 'Signature', s.SignatureID, s.DocTitle + ' for ' + s.VolunteerID);
  notifyAdmins_('Countersign: ' + s.DocTitle + ' for ' + v.Name,
    [v.Name + ' (' + v.VolunteerID + ') and their supervisor ' + sig.typedName + ' signed the ' + s.DocTitle + '. It needs an HFJ countersignature.']);
}

/** HFJ countersignature on one or more agreements, with one drawn signature. */
function countersign_(signatureIds, input, actor) {
  var sig = checkSignatureInput_(Object.assign({ consent: true }, input));
  var title = String(input.title || '').trim().slice(0, 80);
  if (!title) throw new Error('Enter your title (for example, CEO).');
  var all = readRows_(TABS.SIGNATURES);
  var touched = {};
  signatureIds.forEach(function (id) {
    var s = all.filter(function (r) { return r.SignatureID === id; })[0];
    if (!s || s.Status !== SIGNATURE_STATUS.AWAITING_HFJ) throw new Error(id + ' isn\'t waiting for a countersignature.');
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', s.VolunteerID);
    var patch = {
      CountersignedBy: sig.typedName, CountersignTitle: title, CountersignedAt: new Date(),
      CountersignImage: sig.image, Status: SIGNATURE_STATUS.COMPLETE, UpdatedAt: new Date()
    };
    var merged = Object.assign({}, s, patch);
    var values = s.FieldsJson ? JSON.parse(s.FieldsJson) : { Name: v.Name };
    fileSignedPdf_(merged, v, { Title: s.DocTitle, Version: s.DocVersion, Body: s.DocBody, EffectiveDate: '' }, values);
    patch.PdfFileId = merged.PdfFileId;
    patch.PdfUrl = merged.PdfUrl;
    updateRow_(TABS.SIGNATURES, s._row, patch);
    logAudit_(actor, 'document.countersign', 'Signature', id, s.DocTitle + ' for ' + s.VolunteerID + ' by ' + sig.typedName + ', ' + title);
    touched[v.VolunteerID] = v;
  });
  Object.keys(touched).forEach(function (id) { completeSatisfiedRequirements_(touched[id], actor); });
}

/** Renders the PDF with every signature collected so far and files it. Sets PdfFileId/PdfUrl on `row`. */
function fileSignedPdf_(row, v, doc, values) {
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var fmt = function (d) { return d ? Utilities.formatDate(new Date(d), tz, 'yyyy-MM-dd HH:mm z') : ''; };
  var sigs = [{ role: v.Name === row.SignerName ? 'Volunteer' : 'Volunteer (' + v.Name + ')',
    name: row.SignerName, signedAt: row.SignedAtText || fmt(row.SignedAt), image: row.SignerImage, extra: v.Email }];
  if (row.SupervisorSignedAt) {
    sigs.push({ role: 'Supervising clinician', name: row.SupervisorName, signedAt: fmt(row.SupervisorSignedAt),
      image: row.SupervisorImage, extra: row.SupervisorEmail });
  }
  if (row.CountersignedAt) {
    sigs.push({ role: 'For Healthcare for Justice', name: row.CountersignedBy, title: row.CountersignTitle,
      signedAt: fmt(row.CountersignedAt), image: row.CountersignImage });
  }
  var record = 'HFJ volunteer portal record ' + row.SignatureID + ' · ' + v.VolunteerID + ' · ' +
    doc.Title + ' v' + doc.Version + ' · signed electronically by each party named above.';
  var html = buildSignedDocumentHtml(doc, values, sigs, record);
  var name = documentFileName(today_(), v, doc.Title, doc.Version, 'pdf');
  var saved = saveFile_(ensureVolunteerFolder_(v), name, pdfFromHtml_(html, name));
  row.PdfFileId = saved.id;
  row.PdfUrl = saved.url;
}

/** Marks requirements complete that the volunteer's finished documents now cover. */
function completeSatisfiedRequirements_(v, actor) {
  actor = actor || volunteerActor_(v);
  var satisfied = requirementsSatisfiedBy(signaturesFor_(v.VolunteerID), v);
  readRows_(TABS.REQUIREMENTS).forEach(function (r) {
    if (r.VolunteerID !== v.VolunteerID || r.Status === 'Complete') return;
    var s = satisfied[r.RequirementKey];
    if (!s) return;
    updateRow_(TABS.REQUIREMENTS, r._row, {
      Status: 'Complete', CompletedDate: today_(), CompletedBy: 'Signed via portal',
      DocumentUrl: s.PdfUrl || '', Notes: s.DocTitle + ' v' + s.DocVersion + ' (' + s.SignatureID + ')',
      UpdatedAt: new Date(), UpdatedBy: actor.email
    });
    logAudit_(actor, 'requirement.update', 'Requirement', r.RequirementID, v.VolunteerID + ' ' + r.RequirementKey + ': Complete via ' + s.SignatureID);
  });
  afterChange_(v.VolunteerID, actor);
}

function volunteerActor_(v) {
  return { email: 'volunteer:' + v.VolunteerID, name: v.Name };
}
