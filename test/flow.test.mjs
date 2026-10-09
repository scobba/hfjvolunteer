import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fakeGas, GasDate } from './fake-gas.mjs';

const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

function boot(opts) {
  const gas = fakeGas(opts);
  const ctx = vm.createContext(Object.assign({ console }, gas.globals));
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), ctx, { filename: f });
  }
  return { gas, app: ctx };
}

function tab(gas, name) { return gas.main.getSheetByName(name); }

test('setup → add volunteer → credential → requirements → activation → audit', () => {
  const { gas, app } = boot();
  app.setupTabs();
  for (const t of Object.values(app.TABS)) assert.ok(tab(gas, t), t);
  assert.equal(app.readRows_('Admins')[0].Email, 'anthony@hfjvc.org');
  assert.equal(app.getSettings_().BlockIneligibleClaims, 'FALSE');
  assert.equal(gas.main.getSheetByName('Sheet1'), null);

  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'Ann@Example.com', Credential: 'PA', Status: 'Prospective' });
  assert.equal(id, 'HFJV-00001');
  assert.throws(() => app.api_createVolunteer({ Name: 'Dup', Email: 'ann@example.com', Credential: 'MD' }), /already exists/);

  let d = app.api_volunteer(id);
  assert.equal(d.volunteer.Category, 'LIP');
  assert.equal(d.volunteer.AccessToken, undefined);
  assert.equal(d.requirements.length, 10);
  assert.equal(d.eligibility.eligible, false);

  app.api_saveCredential(id, '', { Type: 'CA Physician Assistant License', LicenseNumber: 'PA 1234', ExpirationDate: '2027-05-31' }, false);
  let dash = app.api_dashboard();
  assert.equal(dash.needsReview.length, 1);
  assert.equal(dash.onboarding[0].stuckOn, 'Active CA license/certification');

  d = app.api_volunteer(id);
  const cred = d.credentials[0];
  assert.equal(cred.LicenseNumber, 'PA 1234');
  assert.equal(cred.ExpirationDate, '2027-05-31');
  app.api_verifyCredential(cred.CredentialID, 'https://drive.google.com/file/d/abc');
  d = app.api_volunteer(id);
  assert.equal(d.credentials[0].VerifiedBy, 'anthony@hfjvc.org');
  assert.equal(d.requirements.find((r) => r.RequirementKey === 'license').Status, 'Complete');

  assert.throws(() => app.api_updateRequirement(d.requirements.find((r) => r.RequirementKey === 'license').RequirementID,
    { Status: 'Complete' }), /calculated automatically/);
  const bg = d.requirements.find((r) => r.RequirementKey === 'bg_determination');
  assert.throws(() => app.api_updateRequirement(bg.RequirementID, { Status: 'Complete' }), /Cleared/);
  const sup = d.requirements.find((r) => r.RequirementKey === 'supervisor');
  assert.throws(() => app.api_updateRequirement(sup.RequirementID, { Status: 'Complete' }), /supervisor/);

  for (const r of d.requirements) {
    if (r.owner === 'system') continue;
    const detail = r.RequirementKey === 'bg_determination' ? 'Cleared' : r.RequirementKey === 'supervisor' ? 'Dr. Supervisor' : '';
    app.api_updateRequirement(r.RequirementID, { Status: 'Complete', Detail: detail });
  }
  assert.equal(app.api_volunteer(id).volunteer.Status, 'Prospective', 'attestation still missing');
  app.api_recordAttestation(id, '2026-10-01');
  d = app.api_volunteer(id);
  assert.equal(d.volunteer.Status, 'Active');
  assert.equal(d.eligibility.eligible, true, JSON.stringify(d.eligibility.reasons));
  assert.equal(d.credentials[0].needsVerification, false, 'verified 2026-10-09, after attestation');

  // Renewal: editing the expiry clears verification.
  app.api_saveCredential(id, cred.CredentialID, { ExpirationDate: '2029-05-31' }, false);
  d = app.api_volunteer(id);
  assert.equal(d.credentials[0].verified, false);
  assert.equal(d.eligibility.eligible, false);

  // Telehealth adds Addendum B; unticking removes it again (never started).
  app.api_updateVolunteer(id, { Telehealth: true });
  assert.ok(app.api_volunteer(id).requirements.some((r) => r.RequirementKey === 'add_b_telehealth'));
  app.api_updateVolunteer(id, { Telehealth: false });
  assert.ok(!app.api_volunteer(id).requirements.some((r) => r.RequirementKey === 'add_b_telehealth'));

  const actions = app.readRows_('AuditLog').map((r) => r.Action);
  for (const a of ['volunteer.create', 'credential.create', 'credential.verify', 'requirement.update', 'volunteer.activate', 'credential.update'])
    assert.ok(actions.includes(a), a);
  const roster = app.api_roster();
  assert.equal(roster.length, 1);
});

test('non-admins are refused', () => {
  const { gas, app } = boot();
  app.setupTabs();
  gas.state.user = 'someone@gmail.com';
  assert.throws(() => app.api_dashboard(), /not an @hfjvc.org/);
  gas.state.user = 'other@hfjvc.org';
  assert.throws(() => app.api_dashboard(), /not on the Admins list/);
  gas.state.user = '';
  assert.throws(() => app.api_dashboard(), /Sign in/);
});

test('migration dry run and commit', () => {
  const { gas, app } = boot();
  app.setupTabs();
  assert.throws(() => app.migrationDryRun(), /Copy the three tabs/);
  gas.main.insertSheet('Copy of LIPs').rows = [
    ['Name', 'Email', 'Credential', 'Phone', 'Desired Frequency of 24hr call availability per month', 'Added to HFJ Google Acct?', 'Added to GDrive?'],
    ['Ann Lee', 'ann@example.com', 'MD', 8052084439.0, new GasDate('2026-01-02T00:00:00Z'), 'Y', 'y'],
    ['Bo Ng', 'bo@example.com', 'FNP', '', 2, 'Yes', '']
  ];
  gas.main.insertSheet('Copy of Therapists').rows = [['Name', 'Email', 'Credential'], ['Cy Diaz', 'cy@example.com', 'LMFT']];
  gas.main.insertSheet('Copy of Nurses').rows = [['Name', 'Email', 'Credential'], ['Dee Fox', '', 'RN']];

  assert.equal(app.migrationDryRun(), 4);
  const report = tab(gas, 'MigrationReport').rows.map((r) => r.join('|')).join('\n');
  assert.match(report, /re-collect/);
  assert.match(report, /\(805\) 208-4439/);
  assert.match(report, /LIPs row 2/);
  assert.doesNotMatch(report, /Copy of/);

  assert.deepEqual(JSON.parse(JSON.stringify(app.migrationCommit())), { created: 4, skipped: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(app.migrationCommit())), { created: 0, skipped: 4 });
  const vols = app.readRows_('Volunteers');
  const ann = vols.find((v) => v.Name === 'Ann Lee');
  assert.equal(ann.Phone, '(805) 208-4439');
  assert.equal(ann.CallTargetPerMonth, '');
  assert.match(ann.Notes, /re-collect/);
  assert.equal(vols.find((v) => v.Name === 'Bo Ng').CallTargetPerMonth, 2);
  const athena = app.readRows_('Requirements').filter((r) => r.RequirementKey === 'athena');
  assert.equal(athena.filter((r) => r.Status === 'Complete').length, 1, 'only Ann had both account columns');
  const dash = app.api_dashboard();
  assert.equal(dash.ineligible.length, 4, 'day one: everyone ineligible until backfilled');
});

test('daily job sends reminders once and logs them', () => {
  const { gas, app } = boot();
  app.setupTabs();
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  app.api_saveCredential(id, '', { Type: 'CA Physician & Surgeon License', LicenseNumber: 'A1', ExpirationDate: '2026-11-15' }, true);
  app.api_saveCredential(id, '', { Type: 'BLS', ExpirationDate: '2026-09-01' }, false);
  app.dailyJob();
  assert.equal(gas.sent.length, 2, 'admins only: SendVolunteerReminders is off');
  assert.ok(gas.sent.every((m) => m.to === 'anthony@hfjvc.org'));
  assert.ok(gas.sent.some((m) => /expires 2026-11-15/.test(m.subject)));
  assert.ok(gas.sent.some((m) => /BLS expired/.test(m.subject)));
  app.dailyJob();
  assert.equal(gas.sent.length, 2, 'not re-sent the next run');
  assert.equal(app.readRows_('ReminderLog').length, 2);
});
