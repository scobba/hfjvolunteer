/**
 * The requirement matrix (spec §2). Pure.
 *
 * owner: who completes the item.
 *   system    — computed from other data (credentials, attestation date); not hand-set.
 *   admin     — only an admin can complete it.
 *   volunteer — the volunteer completes it via their link (Phase 2); until then an
 *               admin records it from the paper/PDF trail.
 * when: optional predicate for conditional items (telehealth, precepting).
 */
var REQUIREMENT_DEFS = [
  { key: 'license', label: 'Active CA license/certification', owner: 'system',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'vpa', label: 'Volunteer Provider Agreement', owner: 'volunteer', groups: ['MD_DO', 'NP_PA'] },
  { key: 'nurse_agreement', label: 'Nurse/CNA Agreement', owner: 'volunteer', groups: ['RN_CNA'],
    note: 'Agreement not drafted yet.' },
  { key: 'bh_agreement', label: 'BH Provider & Trainee Agreement', owner: 'volunteer',
    groups: ['BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'add_a_supervision', label: 'Addendum A — NP/PA supervision', owner: 'volunteer', groups: ['NP_PA'] },
  { key: 'add_b_telehealth', label: 'Addendum B — Telehealth', owner: 'volunteer', groups: ['MD_DO', 'NP_PA'],
    when: function (v) { return v.Telehealth === true; } },
  { key: 'bh_add_a_telehealth', label: 'BH Addendum A — Telehealth', owner: 'volunteer',
    groups: ['BH_LICENSED', 'BH_TRAINEE'], when: function (v) { return v.Telehealth === true; } },
  { key: 'add_c_education', label: 'Addendum C — Education/Training', owner: 'volunteer', groups: ['MD_DO', 'NP_PA'],
    when: function (v) { return v.Precepting === true; } },
  { key: 'bg_auth', label: 'Background check authorization', owner: 'volunteer',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'bg_determination', label: 'Background check determination', owner: 'admin',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'hipaa', label: 'HIPAA/PHI training + confidentiality agreement', owner: 'volunteer',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'malpractice', label: 'Added to malpractice policy', owner: 'admin',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'athena', label: 'Athena EMR access provisioned', owner: 'admin',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] },
  { key: 'supervisor', label: 'Named supervisor', owner: 'admin', groups: ['NP_PA', 'BH_TRAINEE'] },
  { key: 'school', label: 'School/program verification', owner: 'admin', groups: ['BH_TRAINEE'] },
  { key: 'attestation', label: 'Annual re-attestation', owner: 'system',
    groups: ['MD_DO', 'NP_PA', 'RN_CNA', 'BH_LICENSED', 'BH_TRAINEE'] }
];

function credentialInfo(credential) {
  return VOLUNTEER_CREDENTIALS[credential] || null;
}

function categoryForCredential(credential) {
  var info = credentialInfo(credential);
  return info ? GROUP_CATEGORY[info.group] : '';
}

function requirementDef(key) {
  for (var i = 0; i < REQUIREMENT_DEFS.length; i++) {
    if (REQUIREMENT_DEFS[i].key === key) return REQUIREMENT_DEFS[i];
  }
  return null;
}

/** Label as shown for this volunteer (trainees hold a registration, not a license). */
function requirementLabel(def, group) {
  if (def.key === 'license' && group === 'BH_TRAINEE') return 'Active CA registration';
  return def.label;
}

/**
 * Requirement definitions that apply to a volunteer, in matrix order.
 * Returns null when the credential is unknown — the caller must flag it
 * rather than silently treating the volunteer as having no requirements.
 */
function requiredDefsFor(volunteer) {
  var info = credentialInfo(volunteer.Credential);
  if (!info) return null;
  return REQUIREMENT_DEFS.filter(function (def) {
    return def.groups.indexOf(info.group) !== -1 && (!def.when || def.when(volunteer));
  });
}
