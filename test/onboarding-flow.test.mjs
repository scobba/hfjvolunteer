import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, plain } from './boot.mjs';

const DOCS = [
  ['phi_policy', 'PHI Policy', '1.0', '2026-03-08', '# PHI Policy\nRead this.'],
  ['confidentiality', 'Confidentiality Agreement', '1.0', '2026-03-08', '# Confidentiality\nName: {{Name}}\nRole: {{Role}}'],
  ['background_auth', 'Background Check Authorization', '1.0', '', '# Background\nDOB: {{DateOfBirth}}\nAddress: {{Address}}'],
  ['vpa', 'Volunteer Provider Agreement', '1.0', '', '# VPA\nBetween HFJ and {{Name}}, beginning {{Date}}.'],
  ['bh_agreement', 'BH Agreement', '1.0', '', '# BH\n{{Name}} supervised by {{SupervisingClinician}} ({{SupervisorLicense}}).'],
  ['attestation', 'Annual Attestation', '1.0', '', '# Attestation\nAll true.']
];

function setup(opts) {
  const ctx = boot(opts);
  const { app, gas } = ctx;
  app.setupTabs();
  app.updateRow_('Admins', 2, { Name: 'Anthony Walls' });
  const sh = gas.main.getSheetByName('Documents');
  DOCS.forEach((d) => sh.appendRow([...d, '']));
  return ctx;
}

const tokenFrom = (mail, param) => mail.body.match(new RegExp('[?]' + param + '=([a-f0-9]{64})'))[1];
const sig = { typedName: 'Ann Lee', image: 'data:image/png;base64,iVBORw0KGgo=', consent: true };
const pdfFile = { name: 'license.pdf', mime: 'application/pdf', base64: Buffer.from('%PDF-1.7 test').toString('base64') };

function allCells(gas) {
  return gas.main.getSheets().flatMap((s) => s.rows.flat()).map(String).join('\n');
}

test('invite → portal → license upload → sign/acknowledge → countersign → requirements complete', () => {
  const { app, gas } = setup();
  const res = plain(app.api_bulkInvite('Ann Lee, ann@example.com, MD', 'Active'));
  assert.deepEqual(res, { created: 1, invited: 1, skipped: [], errors: [] });
  const invite = gas.sent.find((m) => m.to === 'ann@example.com');
  assert.match(invite.body, /https:\/\/script\.google\.com\/macros\/s\/PORTAL\/exec\?t=/);
  const token = tokenFrom(invite, 't');
  assert.ok(!allCells(gas).includes(token), 'only the hash is stored');

  let s = app.portal_bootstrap(token);
  assert.equal(s.volunteer.Name, 'Ann Lee');
  assert.ok(gas.files[app.readRows_('Volunteers')[0].FolderId], 'their own folder exists');
  assert.equal(Object.values(gas.files).find((f) => f.name === 'HFJ Volunteers').mimeType, 'application/vnd.google-apps.folder');
  assert.ok(gas.permissions.some((p) => p.emailAddress === 'anthony@hfjvc.org'), 'admins can open the folders');

  assert.throws(() => app.portal_saveProfile(token, { Phone: '' }), /phone/);
  s = app.portal_saveProfile(token, { Phone: '805-555-0100', CallTargetPerMonth: '2', Name: 'Hacker', Status: 'Departed' });
  const v = app.readRows_('Volunteers')[0];
  assert.equal(v.Name, 'Ann Lee', 'name is not volunteer-editable');
  assert.equal(v.Status, 'Active');
  assert.equal(v.CallTargetPerMonth, 2);

  assert.throws(() => app.portal_saveCredential(token, { Type: 'CA Physician & Surgeon License', LicenseNumber: 'A1', ExpirationDate: '2027-06-30' }, null), /attach/);
  assert.throws(() => app.portal_saveCredential(token, { Type: 'CA Physician & Surgeon License', LicenseNumber: 'A1', ExpirationDate: '2027-06-30' },
    { name: 'x.pdf', mime: 'application/pdf', base64: Buffer.from('<html>').toString('base64') }), /Only PDF or image/);
  const before = gas.sent.length;
  s = app.portal_saveCredential(token, { Type: 'CA Physician & Surgeon License', LicenseNumber: 'A1', ExpirationDate: '2027-06-30', VerifiedBy: 'me' }, pdfFile);
  const cred = app.readRows_('Credentials')[0];
  assert.equal(cred.VerifiedBy, '', 'volunteers cannot verify');
  assert.match(cred.UploadedDocUrl, /drive\.google\.com\/file\/d\//);
  assert.ok(gas.sent.slice(before).some((m) => /Verify: CA Physician/.test(m.subject)), 'admins told at once');
  assert.equal(plain(s.tasks).find((t) => t.key === 'license-0').status, 'waiting');

  app.portal_acknowledge(token, 'phi_policy');
  assert.throws(() => app.portal_sign(token, 'confidentiality', Object.assign({}, sig, { consent: false, fields: { Role: 'MD' } })), /electronically/);
  app.portal_sign(token, 'confidentiality', Object.assign({ fields: { Role: 'MD' } }, sig));
  app.portal_sign(token, 'background_auth', Object.assign({ fields: {
    LegalName: 'Ann Lee', DateOfBirth: '1980-02-29', Phone: '805', Email: 'ann@example.com', Address: '1 Secret Lane'
  } }, sig));
  assert.ok(!allCells(gas).includes('1 Secret Lane') && !allCells(gas).includes('1980-02-29'), 'background answers never reach the sheet');
  const bgPdf = Object.values(gas.files).find((f) => /Background Check Authorization/.test(f.name));
  assert.match(bgPdf.media.html, /1 Secret Lane/, '…only the signed PDF');

  assert.throws(() => app.portal_sign(token, 'add_a_supervision', sig), /doesn't apply/);
  app.portal_sign(token, 'vpa', sig);
  assert.throws(() => app.portal_sign(token, 'vpa', sig), /already signed/);
  s = app.portal_sign(token, 'attestation', sig);
  assert.equal(app.readRows_('Volunteers')[0].LastAttestationDate, '2026-10-09');

  const reqs = () => Object.fromEntries(app.readRows_('Requirements').map((r) => [r.RequirementKey, r]));
  assert.equal(reqs().hipaa.Status, 'Complete');
  assert.match(reqs().hipaa.DocumentUrl, /drive\.google\.com/);
  assert.equal(reqs().bg_auth.Status, 'Complete');
  assert.equal(reqs().vpa.Status, 'Not started', 'waits for HFJ');
  assert.ok(gas.sent.some((m) => /Countersign: Volunteer Provider Agreement/.test(m.subject)));

  const dash = plain(app.api_dashboard());
  assert.equal(dash.awaitingHfj.length, 1);
  assert.throws(() => app.api_countersign([dash.awaitingHfj[0].signatureId], { typedName: 'Anthony Walls', image: sig.image }), /title/);
  app.api_countersign([dash.awaitingHfj[0].signatureId], { typedName: 'Anthony Walls', title: 'CEO', image: sig.image });
  assert.equal(reqs().vpa.Status, 'Complete');
  const vpaPdf = Object.values(gas.files).filter((f) => /Volunteer Provider Agreement/.test(f.name)).pop();
  assert.match(vpaPdf.media.html, /Between HFJ and <span class="filled">Ann Lee/);
  assert.match(vpaPdf.media.html, /Anthony Walls, CEO/);
  assert.equal(plain(app.api_dashboard()).awaitingHfj.length, 0);

  const actions = app.readRows_('AuditLog').map((r) => r.Action);
  for (const a of ['token.issue', 'volunteer.invite', 'portal.open', 'portal.credential', 'document.sign', 'document.acknowledge', 'document.countersign'])
    assert.ok(actions.includes(a), a);
});

test('editing the Documents tab after signing does not change what was countersigned', () => {
  const { app, gas } = setup();
  app.api_bulkInvite('Ann Lee, ann@example.com, MD', 'Prospective');
  const token = tokenFrom(gas.sent[0], 't');
  app.portal_sign(token, 'vpa', sig);
  const sh = gas.main.getSheetByName('Documents');
  const row = sh.rows.findIndex((r) => r[0] === 'vpa');
  sh.rows[row][4] = '# VPA\nNEW WORDING';
  const id = plain(app.api_dashboard()).awaitingHfj[0].signatureId;
  app.api_countersign([id], { typedName: 'Anthony Walls', title: 'CEO', image: sig.image });
  const pdf = Object.values(gas.files).filter((f) => /Volunteer Provider Agreement/.test(f.name)).pop();
  assert.doesNotMatch(pdf.media.html, /NEW WORDING/);
});

test('BH trainee: supervisor signs through their own one-time link, then HFJ', () => {
  const { app, gas } = setup();
  app.api_bulkInvite('Cy Diaz, cy@example.com, AMFT', 'Prospective');
  const token = tokenFrom(gas.sent.find((m) => m.to === 'cy@example.com'), 't');
  const fields = { SupervisingClinician: 'Dr. Sue Pervisor', SupervisorLicense: 'LMFT 12345', SupervisorEmail: 'Sue@Clinic.org',
    TrainingProgram: 'MFT', Institution: 'CSUCI' };
  assert.throws(() => app.portal_sign(token, 'bh_agreement', Object.assign({ fields: { SupervisingClinician: 'X' } }, sig)), /required/);
  app.portal_sign(token, 'bh_agreement', Object.assign({ fields }, sig));
  const mail = gas.sent.find((m) => m.to === 'sue@clinic.org');
  assert.ok(mail, 'supervisor emailed');
  const stoken = tokenFrom(mail, 's');
  assert.match(app.supervisor_bootstrap(stoken).html, /Dr\. Sue Pervisor/);
  app.supervisor_sign(stoken, Object.assign({}, sig, { typedName: 'Sue Pervisor' }));
  assert.throws(() => app.supervisor_sign(stoken, sig), /no longer valid/, 'one-time link');
  const s = app.readRows_('Signatures').find((r) => r.DocKey === 'bh_agreement');
  assert.equal(s.Status, 'Awaiting HFJ');
  app.api_countersign([s.SignatureID], { typedName: 'Anthony Walls', title: 'CEO', image: sig.image });
  const req = app.readRows_('Requirements').find((r) => r.RequirementKey === 'bh_agreement');
  assert.equal(req.Status, 'Complete');
  const pdf = Object.values(gas.files).filter((f) => /BH Agreement/.test(f.name)).pop();
  assert.match(pdf.media.html, /Supervising clinician/);
});

test('links: revoked or replaced links stop working; departed volunteers are locked out', () => {
  const { app, gas } = setup();
  app.api_bulkInvite('Ann Lee, ann@example.com, MD', 'Active');
  const first = tokenFrom(gas.sent[0], 't');
  const id = app.readRows_('Volunteers')[0].VolunteerID;
  app.api_invite(id);
  const second = tokenFrom(gas.sent.filter((m) => m.to === 'ann@example.com').pop(), 't');
  assert.throws(() => app.portal_bootstrap(first), /no longer valid/);
  app.portal_bootstrap(second);
  app.api_revokeLink(id);
  assert.throws(() => app.portal_bootstrap(second), /no longer valid/);
  app.api_invite(id);
  const third = tokenFrom(gas.sent.filter((m) => m.to === 'ann@example.com').pop(), 't');
  app.api_updateVolunteer(id, { Status: 'Departed' });
  assert.throws(() => app.portal_bootstrap(third), /no longer valid/);
  assert.throws(() => app.portal_bootstrap('not-a-token'), /no longer valid/);
});

test('admin uploads of existing signed documents; background reports are refused', () => {
  const { app, gas } = setup();
  const id = app.api_createVolunteer({ Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD', Status: 'Active' });
  const reqs = () => Object.fromEntries(app.readRows_('Requirements').map((r) => [r.RequirementKey, r]));
  const url = app.api_uploadRequirementDocument(reqs().vpa.RequirementID, pdfFile, '2025-09-01');
  assert.equal(reqs().vpa.Status, 'Complete');
  assert.equal(reqs().vpa.CompletedDate, '2025-09-01');
  assert.equal(reqs().vpa.DocumentUrl, url);
  assert.ok(Object.values(gas.files).some((f) => f.name === '2025-09-01 Lee, Ann – Volunteer Provider Agreement.pdf'));
  assert.throws(() => app.api_uploadRequirementDocument(reqs().bg_determination.RequirementID, pdfFile, ''), /never stored/);
  assert.throws(() => app.api_uploadRequirementDocument(reqs().license.RequirementID, pdfFile, ''), /calculated/);
  // The portal then shows the VPA as on file, not to sign again.
  app.api_invite(id);
  const t = plain(app.portal_bootstrap(tokenFrom(gas.sent.pop(), 't')).tasks);
  assert.equal(t.find((x) => x.key === 'doc-vpa').note, 'On file with HFJ.');
});

test('without a deployed portal, invites fail before anyone is created', () => {
  const { app } = setup({ urls: false });
  assert.throws(() => app.api_bulkInvite('Ann Lee, ann@example.com, MD', 'Active'), /isn't deployed/);
  assert.equal(app.readRows_('Volunteers').length, 0);
});
