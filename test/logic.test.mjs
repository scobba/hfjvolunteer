import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp, readSrc } from './load.mjs';

const app = loadApp();
const TODAY = '2026-10-09';
// Arrays built inside the vm context have a different Array prototype.
const same = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

function md(over) {
  return Object.assign({ VolunteerID: 'HFJV-00001', Name: 'Dr A', Credential: 'MD', Status: 'Active',
    Telehealth: false, Precepting: false, LastAttestationDate: '2026-03-01', Email: 'a@example.com' }, over);
}
function completeReqs(v) {
  return app.requiredDefsFor(v).map((d) => ({ RequirementKey: d.key, Status: 'Complete',
    Detail: d.key === 'bg_determination' ? 'Cleared' : '', CompletedDate: '2026-01-01' }));
}
function lic(over) {
  return Object.assign({ CredentialID: 'CRED-00001', VolunteerID: 'HFJV-00001', Type: 'CA Physician & Surgeon License',
    LicenseNumber: 'A12345', ExpirationDate: '2027-06-30', VerifiedBy: 'Anthony Walls', VerifiedDate: '2026-09-01' }, over);
}

test('date helpers', () => {
  assert.equal(app.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(app.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(app.addYears('2028-02-29', 1), '2029-02-28');
  assert.equal(app.daysBetween('2026-10-09', '2026-12-08'), 60);
});

test('matrix follows the spec table', () => {
  const keys = (v) => app.requiredDefsFor(v).map((d) => d.key);
  same(keys(md()), ['license', 'vpa', 'bg_auth', 'bg_determination', 'hipaa', 'malpractice', 'athena', 'attestation']);
  assert.ok(keys(md({ Credential: 'NP' })).includes('add_a_supervision'));
  assert.ok(keys(md({ Credential: 'PA' })).includes('supervisor'));
  assert.ok(keys(md({ Telehealth: true, Precepting: true })).includes('add_b_telehealth'));
  assert.ok(keys(md({ Precepting: true })).includes('add_c_education'));
  const rn = keys(md({ Credential: 'RN', Telehealth: true }));
  assert.ok(rn.includes('nurse_agreement') && !rn.includes('vpa') && !rn.includes('add_b_telehealth'));
  const trainee = keys(md({ Credential: 'AMFT', Telehealth: true }));
  for (const k of ['bh_agreement', 'bh_add_a_telehealth', 'supervisor', 'school']) assert.ok(trainee.includes(k), k);
  assert.ok(!keys(md({ Credential: 'LMFT' })).includes('supervisor'));
  assert.equal(app.requiredDefsFor(md({ Credential: 'Wizard' })), null);
  assert.equal(app.categoryForCredential('CNA'), 'NurseCNA');
});

test('fully complete, verified, current volunteer is eligible', () => {
  const v = md();
  const e = app.evaluateEligibility(v, completeReqs(v), [lic()], TODAY, {});
  same(e.reasons, []);
  assert.equal(e.eligible, true);
});

test('day one: no license data blocks everyone', () => {
  const v = md({ LastAttestationDate: '' });
  const e = app.evaluateEligibility(v, [], [], TODAY, {});
  assert.equal(e.eligible, false);
  assert.ok(e.reasons.some((r) => /no CA Physician & Surgeon License on file/.test(r)));
  assert.ok(e.reasons.some((r) => /attestation/.test(r)));
});

test('unverified upload does not count; expiring before the shift date blocks', () => {
  const v = md();
  const reqs = completeReqs(v);
  let e = app.evaluateEligibility(v, reqs, [lic({ VerifiedBy: '', VerifiedDate: '' })], TODAY, {});
  assert.ok(e.reasons.some((r) => /awaiting verification/.test(r)));
  e = app.evaluateEligibility(v, reqs, [lic({ ExpirationDate: '2026-11-01' })], '2026-11-02', {});
  assert.equal(e.eligible, false);
  assert.equal(e.items.find((i) => i.key === 'license').status, 'Expired');
  e = app.evaluateEligibility(v, reqs, [lic({ ExpirationDate: '2026-11-01' })], '2026-11-01', {});
  assert.equal(e.eligible, true, 'valid through its expiration date');
});

test('NP needs both RN license and NP certificate', () => {
  const v = md({ Credential: 'NP' });
  const reqs = completeReqs(v);
  const rn = lic({ Type: 'CA Registered Nurse License' });
  assert.equal(app.evaluateEligibility(v, reqs, [rn], TODAY, {}).eligible, false);
  const np = lic({ CredentialID: 'CRED-00002', Type: 'CA Nurse Practitioner Certificate' });
  assert.equal(app.evaluateEligibility(v, reqs, [rn, np], TODAY, {}).eligible, true);
});

test('other lapsed credentials block unless renewed', () => {
  const v = md();
  const bls = { CredentialID: 'CRED-00009', Type: 'BLS', ExpirationDate: '2026-09-01' };
  assert.equal(app.evaluateEligibility(v, completeReqs(v), [lic(), bls], TODAY, {}).eligible, false);
  const renewed = { CredentialID: 'CRED-00010', Type: 'BLS', ExpirationDate: '2028-09-01' };
  assert.equal(app.evaluateEligibility(v, completeReqs(v), [lic(), bls, renewed], TODAY, {}).eligible, true);
});

test('background check: not cleared blocks; interval applies only when set', () => {
  const v = md();
  const reqs = completeReqs(v);
  const bg = reqs.find((r) => r.RequirementKey === 'bg_determination');
  bg.Detail = 'Not cleared';
  assert.equal(app.evaluateEligibility(v, reqs, [lic()], TODAY, {}).eligible, false);
  bg.Detail = 'Cleared';
  bg.CompletedDate = '2023-01-01';
  assert.equal(app.evaluateEligibility(v, reqs, [lic()], TODAY, {}).eligible, true);
  assert.equal(app.evaluateEligibility(v, reqs, [lic()], TODAY, { bgIntervalMonths: 24 }).eligible, false);
});

test('inactive status blocks; attestation lapses after a year', () => {
  const v = md({ Status: 'Inactive' });
  assert.equal(app.evaluateEligibility(v, completeReqs(v), [lic()], TODAY, {}).eligible, false);
  const old = md({ LastAttestationDate: '2025-10-01' });
  assert.equal(app.evaluateEligibility(old, completeReqs(old), [lic()], TODAY, {}).eligible, false);
});

test('re-verification is prompted after attestation', () => {
  assert.equal(app.needsVerification(lic(), md({ LastAttestationDate: '2026-08-01' })), false);
  assert.equal(app.needsVerification(lic(), md({ LastAttestationDate: '2026-09-15' })), true);
});

test('dashboard blocks', () => {
  const a = md();
  const b = md({ VolunteerID: 'HFJV-00002', Name: 'New RN', Credential: 'RN', Status: 'Prospective' });
  const data = {
    volunteers: [a, b],
    credentials: [lic({ ExpirationDate: '2026-10-30' }),
      { CredentialID: 'CRED-00002', VolunteerID: 'HFJV-00002', Type: 'CA Registered Nurse License', ExpirationDate: '2027-01-01' }],
    requirements: completeReqs(a).map((r) => Object.assign({ VolunteerID: 'HFJV-00001' }, r)),
    shifts: []
  };
  const d = app.buildDashboard(data, TODAY, { reminderLeadDays: 60 });
  assert.equal(d.needsReview.length, 1);
  assert.match(d.needsReview[0].lookupUrl, /^https:/);
  assert.equal(d.expiring.length, 1);
  assert.equal(d.expiring[0].window, 30);
  assert.equal(d.ineligible.length, 0);
  assert.equal(d.onboarding.length, 1);
  assert.equal(d.onboarding[0].stuckOn, 'Active CA license/certification');
  assert.equal(d.coverage.live, false);
  const g = app.coverageGaps([{ ShiftDate: TODAY, VolunteerID: 'HFJV-00001' }], TODAY, 3);
  same(g.gaps, ['2026-10-10', '2026-10-11']);
});

test('reminders: once at 60 days, every 30 days when expired, volunteer copy behind setting', () => {
  const data = { volunteers: [md()], credentials: [lic({ ExpirationDate: '2026-12-01' })] };
  const opts = { leadDays: 60, overdueIntervalDays: 30, attestationLeadDays: 30, sendToVolunteers: false };
  let plan = app.planReminders(data, TODAY, opts, {});
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'expiring');
  assert.equal(plan[0].volunteerTo, '');
  assert.equal(app.planReminders(data, TODAY, opts, { [plan[0].key]: { lastSent: TODAY } }).length, 0);

  plan = app.planReminders(data, TODAY, Object.assign({}, opts, { sendToVolunteers: true }), {});
  assert.equal(plan[0].volunteerTo, 'a@example.com');

  const expired = { volunteers: [md()], credentials: [lic({ ExpirationDate: '2026-09-01' })] };
  const key = 'expired|CRED-00001|2026-09-01';
  assert.equal(app.planReminders(expired, TODAY, opts, { [key]: { lastSent: '2026-09-20' } }).length, 0);
  assert.equal(app.planReminders(expired, TODAY, opts, { [key]: { lastSent: '2026-09-09' } }).length, 1);

  const att = { volunteers: [md({ LastAttestationDate: '2025-10-20' })], credentials: [] };
  assert.equal(app.planReminders(att, TODAY, opts, {}).length, 0, 'attestation is volunteer-only');
  plan = app.planReminders(att, TODAY, Object.assign({}, opts, { sendToVolunteers: true }), {});
  assert.equal(plan[0].kind, 'attestation');

  const gone = { volunteers: [md({ Status: 'Departed' })], credentials: [lic({ ExpirationDate: '2026-09-01' })] };
  assert.equal(app.planReminders(gone, TODAY, opts, {}).length, 0);
});

test('migration parsing: corrupted call frequency, float phone, Y/y/Yes', () => {
  assert.equal(app.parseCallTarget({ __date: '2026-01-02' }).value, '');
  assert.match(app.parseCallTarget({ __date: '2026-01-02' }).warning, /re-collect/);
  assert.equal(app.parseCallTarget('1/2').value, '');
  assert.equal(app.parseCallTarget(2).value, 2);
  assert.equal(app.parseCallTarget('3').value, 3);
  assert.equal(app.normalizePhone(8052084439.0).value, '(805) 208-4439');
  assert.equal(app.normalizePhone('8052084439.0').value, '(805) 208-4439');
  for (const y of ['Y', 'y', 'Yes', 'yes', true]) assert.equal(app.parseBool(y), true, String(y));
  for (const n of ['', 'N', 'no', false]) assert.equal(app.parseBool(n), false, String(n));
  assert.equal(app.parseBool('maybe'), null);
  assert.equal(app.parseCredential('M.D.'), 'MD');
  assert.equal(app.parseCredential('FNP-C'), 'NP');
  assert.equal(app.parseCredential('PA-C'), 'PA');
  assert.equal(app.parseCredential('AMFT'), 'AMFT');
  assert.equal(app.parseCredential('LMFT'), 'LMFT');
  assert.equal(app.parseCredential('Registered Nurse'), 'RN');
});

test('migration: three tabs merge, both Google-account columns map to Athena', () => {
  const lip = app.parseSourceTab('LIPs', [
    ['Name', 'Email', 'Credential', 'Phone', 'Desired Frequency of 24hr call availability per month',
      'Added to HFJ Google Acct?', 'Added to GDrive?', 'Spanish', 'Signed Volunteer Provider Agreement?', 'Favorite color'],
    ['Ann Lee', 'Ann@Example.com', 'MD', 8052084439.0, { __date: '2026-01-02' }, 'Y', 'yes', 'like a 2nd grader', 'Yes', 'blue'],
    ['Bo Ng', 'bo@example.com', 'NP', '', 2, 'Y', '', '', 'y', ''],
    ['', '', '', '', '', '', '', '', '', '']
  ]);
  assert.equal(lip.records.length, 2);
  const ann = lip.records[0];
  assert.equal(ann.fields.Category, 'LIP');
  assert.equal(ann.fields.Phone, '(805) 208-4439');
  assert.equal(ann.fields.CallTargetPerMonth, '');
  assert.ok(ann.warnings.some((w) => /re-collect/.test(w)));
  assert.equal(ann.fields.SpanishFluency, 'like a 2nd grader');
  assert.equal(ann.reqs.athena.complete, true);
  assert.equal(ann.reqs.vpa.complete, true);
  assert.ok(ann.notes.includes('Favorite color: blue'));
  assert.equal(lip.records[1].reqs.athena.complete, false, 'both columns must be checked');
  assert.equal(lip.records[1].fields.CallTargetPerMonth, 2);

  const bh = app.parseSourceTab('Therapists', [
    ['Name', 'Email', 'Credential', 'BH Agreement signed', 'Addendum A'],
    ['Cy Diaz', 'cy@example.com', 'AMFT', 'Y', 'Y']
  ]);
  assert.equal(bh.records[0].fields.Category, 'BehavioralHealth');
  assert.equal(bh.records[0].reqs.bh_agreement.complete, true);
  assert.equal(bh.records[0].reqs.bh_add_a_telehealth.complete, true);
  assert.equal(bh.records[0].fields.Telehealth, true);

  const dup = app.parseSourceTab('Nurses', [['Name', 'Email'], ['Ann Lee', 'ann@example.com']]);
  const merged = app.mergeRecords([].concat(lip.records, bh.records, dup.records));
  assert.equal(merged.length, 3);
});

test('migration reads copied-in tabs, or the ones Settings names', () => {
  const names = ['Volunteers', 'Copy of LIPs', 'Copy of Nurses', 'Settings'];
  assert.deepEqual([...app.migrationSourceTabNames(names, '')], ['Copy of LIPs', 'Copy of Nurses']);
  assert.deepEqual([...app.migrationSourceTabNames(names, ' LIPs old , Nurses old ')], ['LIPs old', 'Nurses old']);
});

test('manifest asks only for the bound spreadsheet and app-created Drive files', () => {
  const scopes = JSON.parse(readSrc('appsscript.json')).oauthScopes;
  assert.ok(scopes.includes('https://www.googleapis.com/auth/spreadsheets.currentonly'));
  assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
  // Full Drive or Sheets access would reach the HFJ EMR, which lives in Google Drive.
  const broad = scopes.filter((s) => /auth\/(spreadsheets|drive|drive\.readonly|documents)$/.test(s));
  assert.deepEqual(broad, []);
});

test('admin page script parses', () => {
  const html = readSrc('App.html');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new Function(js));
});

test('no two files in src/ share a name (Apps Script ignores the extension)', async () => {
  const fs = await import('node:fs');
  const names = fs.readdirSync(new URL('../src/', import.meta.url))
    .filter((f) => /\.(gs|html)$/.test(f)).map((f) => f.replace(/\.(gs|html)$/, '').toLowerCase());
  assert.deepEqual(names.filter((n, i) => names.indexOf(n) !== i), []);
});
