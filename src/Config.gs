/**
 * Tab layouts, default settings and the credential catalogue.
 * Column types drive conversion in Db.gs: text | date | datetime | bool | int.
 */

var TABS = {
  VOLUNTEERS: 'Volunteers',
  CREDENTIALS: 'Credentials',
  REQUIREMENTS: 'Requirements',
  CALL_SHIFTS: 'CallShifts',
  SETTINGS: 'Settings',
  ADMINS: 'Admins',
  AUDIT: 'AuditLog',
  REMINDER_LOG: 'ReminderLog',
  DOCUMENTS: 'Documents',
  SIGNATURES: 'Signatures'
};

var SCHEMAS = {
  Volunteers: [
    ['VolunteerID', 'text'], ['Name', 'text'], ['PreferredName', 'text'],
    ['Category', 'text'], ['Credential', 'text'], ['Email', 'text'],
    ['Phone', 'text'], ['SpanishFluency', 'text'], ['Notes', 'text'],
    ['Status', 'text'], ['CallTargetPerMonth', 'int'], ['OnSignal', 'bool'],
    ['Telehealth', 'bool'], ['Precepting', 'bool'],
    ['DriveFolderUrl', 'text'], ['FolderId', 'text'], ['FolderUrl', 'text'],
    ['AccessToken', 'text'], ['TokenIssuedAt', 'datetime'], ['TokenRevokedAt', 'datetime'],
    ['StartDate', 'date'], ['LastAttestationDate', 'date'],
    ['InvitedAt', 'datetime'], ['ProfileConfirmedAt', 'datetime'],
    ['CreatedAt', 'datetime'], ['CreatedBy', 'text'], ['UpdatedAt', 'datetime'], ['UpdatedBy', 'text']
  ],
  Credentials: [
    ['CredentialID', 'text'], ['VolunteerID', 'text'], ['Type', 'text'],
    ['LicenseNumber', 'text'], ['IssuingState', 'text'], ['ExpirationDate', 'date'],
    ['UploadedDocUrl', 'text'], ['VerifiedBy', 'text'], ['VerifiedDate', 'date'],
    ['VerificationMethod', 'text'], ['SourceDocUrl', 'text'],
    ['LastAutoCheck', 'datetime'], ['AutoCheckResult', 'text'], ['Notes', 'text'],
    ['CreatedAt', 'datetime'], ['CreatedBy', 'text'], ['UpdatedAt', 'datetime'], ['UpdatedBy', 'text']
  ],
  Requirements: [
    ['RequirementID', 'text'], ['VolunteerID', 'text'], ['RequirementKey', 'text'],
    ['Requirement', 'text'], ['Status', 'text'], ['CompletedDate', 'date'],
    ['CompletedBy', 'text'], ['DocumentUrl', 'text'], ['Detail', 'text'], ['Notes', 'text'],
    ['UpdatedAt', 'datetime'], ['UpdatedBy', 'text']
  ],
  CallShifts: [
    ['ShiftDate', 'date'], ['VolunteerID', 'text'], ['ClaimedAt', 'datetime'],
    ['ReleasedAt', 'datetime'], ['CalendarEventId', 'text']
  ],
  Settings: [['Key', 'text'], ['Value', 'text'], ['Notes', 'text']],
  Admins: [['Email', 'text'], ['Name', 'text'], ['Active', 'bool']],
  AuditLog: [
    ['Timestamp', 'datetime'], ['Actor', 'text'], ['Action', 'text'],
    ['Entity', 'text'], ['EntityID', 'text'], ['Details', 'text']
  ],
  ReminderLog: [['Key', 'text'], ['LastSentAt', 'datetime'], ['SendCount', 'int']],
  // Edited by admins. The app only reads it.
  Documents: [
    ['DocKey', 'text'], ['Title', 'text'], ['Version', 'text'], ['EffectiveDate', 'date'],
    ['Body', 'text'], ['Notes', 'text']
  ],
  // One row per acknowledgment or signed document. DocBody keeps the exact text
  // that was signed, so a later edit to the Documents tab can't change it.
  // Signature images are small PNG data URLs. Sensitive form answers (the
  // background check) are never stored here, only in the signed PDF.
  Signatures: [
    ['SignatureID', 'text'], ['VolunteerID', 'text'], ['DocKey', 'text'], ['DocTitle', 'text'],
    ['DocVersion', 'text'], ['DocBody', 'text'], ['Kind', 'text'], ['Status', 'text'],
    ['SignerName', 'text'], ['SignedAt', 'datetime'], ['SignerImage', 'text'], ['FieldsJson', 'text'],
    ['SupervisorName', 'text'], ['SupervisorEmail', 'text'], ['SupervisorTokenHash', 'text'],
    ['SupervisorSignedAt', 'datetime'], ['SupervisorImage', 'text'],
    ['CountersignedBy', 'text'], ['CountersignTitle', 'text'], ['CountersignedAt', 'datetime'], ['CountersignImage', 'text'],
    ['PdfFileId', 'text'], ['PdfUrl', 'text'], ['UpdatedAt', 'datetime']
  ]
};

/** [key, default, note]. Values are only written when a key is missing. */
var SETTING_DEFAULTS = [
  ['BackgroundCheckIntervalMonths', '', 'Blank = no recurrence. Pending legal advice.'],
  ['CalendarHorizonDays', '180', 'Call calendar rolling horizon (Phase 3).'],
  ['BlockIneligibleClaims', 'FALSE', 'FALSE = warn only. Flip to TRUE once all volunteers are backfilled.'],
  ['ReminderLeadDays', '60', 'Days before a credential expires that the first reminder goes out.'],
  ['OverdueReminderIntervalDays', '30', 'Repeat interval for expired-credential reminders.'],
  ['AttestationReminderLeadDays', '30', 'Days before annual attestation is due that the volunteer is reminded.'],
  ['SendVolunteerReminders', 'FALSE', 'FALSE = reminders go to admins only. Flip to TRUE once backfill is done.'],
  ['AdminDomain', 'hfjvc.org', 'Admins must sign in with an account on this domain.'],
  ['MigrationSourceTabs', '', 'Old roster tabs copied into this Sheet, comma-separated. Blank = every tab named "Copy of …".']
];

var VOLUNTEER_STATUSES = ['Prospective', 'Active', 'Inactive', 'Departed'];
var REQUIREMENT_STATUSES = ['Not started', 'Sent', 'Complete', 'Expired'];
var BACKGROUND_DETERMINATIONS = ['Cleared', 'Conditional', 'Not cleared'];

var DCA_SEARCH = 'https://search.dca.ca.gov/';

/**
 * Credential (license/certification) types an admin can record, with the board
 * whose primary-source lookup the review screen links to. Confirm the links
 * before go-live; they're here so changing one doesn't touch logic.
 */
var CREDENTIAL_TYPES = {
  'CA Physician & Surgeon License': { board: 'Medical Board of California', lookupUrl: DCA_SEARCH },
  'CA Osteopathic Physician & Surgeon License': { board: 'Osteopathic Medical Board of California', lookupUrl: DCA_SEARCH },
  'CA Physician Assistant License': { board: 'Physician Assistant Board', lookupUrl: DCA_SEARCH },
  'CA Registered Nurse License': { board: 'Board of Registered Nursing', lookupUrl: DCA_SEARCH },
  'CA Nurse Practitioner Certificate': { board: 'Board of Registered Nursing', lookupUrl: DCA_SEARCH },
  'CA Certified Nurse Assistant Certification': { board: 'CDPH Licensing & Certification', lookupUrl: 'https://www.apps.cdph.ca.gov/cvl/SearchPage.aspx' },
  'CA LMFT License': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA LCSW License': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA LPCC License': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA LEP License': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA Psychologist License': { board: 'Board of Psychology', lookupUrl: DCA_SEARCH },
  'CA AMFT Registration': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA ASW Registration': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA APCC Registration': { board: 'Board of Behavioral Sciences', lookupUrl: DCA_SEARCH },
  'CA Psychological Associate Registration': { board: 'Board of Psychology', lookupUrl: DCA_SEARCH },
  // Reserved for e-prescribing via Athena; tracked but not required by the matrix.
  'DEA Registration': { board: 'DEA Diversion Control Division', lookupUrl: 'https://www.deadiversion.usdoj.gov/' },
  'BLS': { board: 'Card issuer (AHA / Red Cross)', lookupUrl: '' },
  'Other': { board: '', lookupUrl: '' }
};

/**
 * Volunteer credential → matrix group and the license(s) that satisfy the
 * "Active CA license" requirement. `licenses` is a list of slots, all
 * required; each slot lists acceptable types (any one will do).
 */
var VOLUNTEER_CREDENTIALS = {
  MD: { group: 'MD_DO', licenses: [['CA Physician & Surgeon License']] },
  DO: { group: 'MD_DO', licenses: [['CA Osteopathic Physician & Surgeon License']] },
  NP: { group: 'NP_PA', licenses: [['CA Registered Nurse License'], ['CA Nurse Practitioner Certificate']] },
  PA: { group: 'NP_PA', licenses: [['CA Physician Assistant License']] },
  RN: { group: 'RN_CNA', licenses: [['CA Registered Nurse License']] },
  CNA: { group: 'RN_CNA', licenses: [['CA Certified Nurse Assistant Certification']] },
  LMFT: { group: 'BH_LICENSED', licenses: [['CA LMFT License']] },
  LCSW: { group: 'BH_LICENSED', licenses: [['CA LCSW License']] },
  LPCC: { group: 'BH_LICENSED', licenses: [['CA LPCC License']] },
  LEP: { group: 'BH_LICENSED', licenses: [['CA LEP License']] },
  Psychologist: { group: 'BH_LICENSED', licenses: [['CA Psychologist License']] },
  AMFT: { group: 'BH_TRAINEE', licenses: [['CA AMFT Registration']] },
  ASW: { group: 'BH_TRAINEE', licenses: [['CA ASW Registration']] },
  APCC: { group: 'BH_TRAINEE', licenses: [['CA APCC Registration']] },
  'Psych Associate': { group: 'BH_TRAINEE', licenses: [['CA Psychological Associate Registration']] }
};

var GROUP_CATEGORY = {
  MD_DO: 'LIP', NP_PA: 'LIP', RN_CNA: 'NurseCNA',
  BH_LICENSED: 'BehavioralHealth', BH_TRAINEE: 'BehavioralHealth'
};
