/**
 * Documents volunteers read, sign or acknowledge (spec §9). Pure.
 *
 * The *text* of each document lives in the Documents tab, edited by admins,
 * so policy wording never sits in this public repo. What lives here is how
 * each document behaves: which requirement it satisfies, what the signer fills
 * in, and who else must sign.
 *
 * kind: 'ack' (read + checkbox) or 'sign' (typed name + drawn signature).
 * fields: filled in by the signer; {{Key}} in the document text shows the value.
 *   prefill: name | email | phone | credential | license | state — taken from the record.
 *   when: 'trainee' — only asked of BH trainees.
 * sensitive: field values go into the signed PDF only, never into the spreadsheet.
 * supervisor: a BH trainee's supervising clinician also signs, via an emailed link.
 * countersign: an HFJ admin signs after the volunteer (and supervisor).
 */
var DOC_FORMS = {
  phi_policy: {
    kind: 'ack', requirements: ['hipaa'],
    ackLabel: 'I have read and understand the HFJ PHI Handling & Documentation Policy, and I will follow it.'
  },
  confidentiality: {
    kind: 'sign', requirements: ['hipaa'],
    fields: [{ key: 'Role', label: 'Role', prefill: 'credential', required: true }]
  },
  background_auth: {
    kind: 'sign', requirements: ['bg_auth'], sensitive: true,
    fields: [
      { key: 'LegalName', label: 'Full legal name', prefill: 'name', required: true },
      { key: 'OtherNames', label: 'Other names used (if any)' },
      { key: 'DateOfBirth', label: 'Date of birth', type: 'date', required: true },
      { key: 'Phone', label: 'Phone number', prefill: 'phone', required: true },
      { key: 'Email', label: 'Email address', prefill: 'email', type: 'email', required: true },
      { key: 'Address', label: 'Current address', type: 'textarea', required: true },
      { key: 'LicenseType', label: 'License type', prefill: 'credential' },
      { key: 'LicenseNumber', label: 'License number', prefill: 'license' },
      { key: 'IssuingState', label: 'Issuing state', prefill: 'state' }
    ]
  },
  vpa: { kind: 'sign', requirements: ['vpa'], countersign: true },
  add_a_supervision: {
    kind: 'sign', requirements: ['add_a_supervision'], countersign: true,
    fields: [{ key: 'SupervisingPhysician', label: 'Supervising physician', required: true }]
  },
  add_b_telehealth: { kind: 'sign', requirements: ['add_b_telehealth'], countersign: true },
  add_c_education: { kind: 'sign', requirements: ['add_c_education'], countersign: true },
  bh_agreement: {
    kind: 'sign', requirements: ['bh_agreement', 'bh_add_a_telehealth'], countersign: true, supervisor: true,
    fields: [
      { key: 'SupervisingClinician', label: 'Supervising licensed clinician', when: 'trainee', required: true },
      { key: 'SupervisorLicense', label: 'Supervisor license type / number', when: 'trainee', required: true },
      { key: 'SupervisorEmail', label: 'Supervisor email (they will get a link to sign)', type: 'email', when: 'trainee', required: true },
      { key: 'TrainingProgram', label: 'Training program', when: 'trainee', required: true },
      { key: 'Institution', label: 'Institution', when: 'trainee', required: true },
      { key: 'ProgramRepresentative', label: 'Program representative', when: 'trainee' }
    ]
  },
  attestation: { kind: 'sign', requirements: ['attestation'], attestation: true }
};

/** Names shown before a document has been added to the Documents tab. */
var DOC_DEFAULT_TITLES = {
  phi_policy: 'HFJ PHI Handling & Documentation Policy', confidentiality: 'HFJ Confidentiality Agreement',
  background_auth: 'Background Check Disclosure and Authorization', vpa: 'Volunteer Provider Agreement',
  add_a_supervision: 'Addendum A: NP/PA Supervision', add_b_telehealth: 'Addendum B: Telehealth Services',
  add_c_education: 'Addendum C: Education and Training',
  bh_agreement: 'Behavioral Health Provider and Trainee Agreement', attestation: 'Annual Volunteer Attestation'
};

/** Display order in the volunteer portal. */
var DOC_ORDER = ['background_auth', 'phi_policy', 'confidentiality', 'vpa', 'add_a_supervision',
  'add_b_telehealth', 'add_c_education', 'bh_agreement', 'attestation'];

var SIGNATURE_STATUS = {
  AWAITING_SUPERVISOR: 'Awaiting supervisor',
  AWAITING_HFJ: 'Awaiting HFJ',
  COMPLETE: 'Complete'
};

function isTrainee(volunteer) {
  var info = credentialInfo(volunteer.Credential);
  return !!info && info.group === 'BH_TRAINEE';
}

/** Fields this volunteer fills in for a document. */
function formFieldsFor(docKey, volunteer) {
  var form = DOC_FORMS[docKey];
  return ((form && form.fields) || []).filter(function (f) {
    return f.when !== 'trainee' || isTrainee(volunteer);
  });
}

function needsSupervisorSignature(docKey, volunteer) {
  return !!(DOC_FORMS[docKey] && DOC_FORMS[docKey].supervisor && isTrainee(volunteer));
}

/** Initial value for a field from what HFJ already has on file. */
function prefillValue(field, volunteer, creds) {
  var info = credentialInfo(volunteer.Credential);
  var licenseTypes = info ? [].concat.apply([], info.licenses) : [];
  var license = (creds || []).filter(function (c) { return licenseTypes.indexOf(c.Type) !== -1; })[0];
  switch (field.prefill) {
    case 'name': return volunteer.Name || '';
    case 'email': return volunteer.Email || '';
    case 'phone': return volunteer.Phone || '';
    case 'credential': return volunteer.Credential || '';
    case 'license': return license ? license.LicenseNumber || '' : '';
    case 'state': return license ? license.IssuingState || 'CA' : 'CA';
    default: return '';
  }
}

/**
 * Checks and trims what the signer typed. Returns { values, errors }.
 * Only declared fields survive, so nothing else from the browser is kept.
 */
function cleanFormValues(docKey, volunteer, raw) {
  var values = {}, errors = [];
  formFieldsFor(docKey, volunteer).forEach(function (f) {
    var v = String((raw && raw[f.key]) || '').trim().slice(0, f.type === 'textarea' ? 500 : 200);
    if (f.required && !v) errors.push(f.label + ' is required.');
    if (v && f.type === 'date' && !isIsoDate(v)) errors.push(f.label + ' must be a date.');
    if (v && f.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) errors.push(f.label + ' must be an email address.');
    values[f.key] = v;
  });
  return { values: values, errors: errors };
}

/** Which documents apply to this volunteer, in portal order. */
function documentsFor(volunteer) {
  var defs = requiredDefsFor(volunteer) || [];
  var keys = defs.map(function (d) { return d.key; });
  return DOC_ORDER.filter(function (docKey) {
    return DOC_FORMS[docKey].requirements.some(function (r) { return keys.indexOf(r) !== -1; });
  });
}

/**
 * Requirement keys fully satisfied by completed signatures/acknowledgments.
 * HIPAA needs both the policy acknowledgment and the confidentiality agreement.
 * The BH Addendum A only counts when the volunteer actually needs it.
 */
function requirementsSatisfiedBy(signatures, volunteer) {
  var done = {};
  signatures.forEach(function (s) {
    if (s.Status === SIGNATURE_STATUS.COMPLETE) done[s.DocKey] = s;
  });
  var out = {};
  var needed = (requiredDefsFor(volunteer) || []).map(function (d) { return d.key; });
  Object.keys(DOC_FORMS).forEach(function (docKey) {
    if (!done[docKey]) return;
    DOC_FORMS[docKey].requirements.forEach(function (req) {
      if (needed.indexOf(req) === -1) return;
      if (req === 'hipaa' && !(done.phi_policy && done.confidentiality)) return;
      if (req === 'attestation') return; // tracked by LastAttestationDate instead
      out[req] = done[req === 'hipaa' ? 'confidentiality' : docKey];
    });
  });
  return out;
}
