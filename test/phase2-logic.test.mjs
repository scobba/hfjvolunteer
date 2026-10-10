import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './load.mjs';

const app = loadApp();
const plain = (x) => JSON.parse(JSON.stringify(x));
const vol = (over) => Object.assign({ VolunteerID: 'HFJV-00001', Name: 'Ann Lee', Credential: 'MD', Status: 'Active',
  Telehealth: false, Precepting: false, Email: 'ann@example.com', Phone: '(805) 555-0100' }, over);

test('document text renders headings, lists, paragraphs and filled blanks, escaping everything', () => {
  const html = app.renderBodyHtml('# Title\n\n## 1. Term\nBegins on {{Date}} for {{Name}}.\nSecond line\n\n- one\n- two\n1. first\n\nUnfilled: {{Missing}} <script>', { Date: '2026-10-09', Name: 'A <b>' });
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>1\. Term<\/h2>/);
  assert.match(html, /<p>Begins on <span class="filled">2026-10-09<\/span> for <span class="filled">A &lt;b&gt;<\/span>\.<br>Second line<\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>\n<ol><li>first<\/li><\/ol>/);
  assert.match(html, /<span class="blank">&nbsp;<\/span> &lt;script&gt;/);
});

test('signed PDF html carries every signature and the version line', () => {
  const html = app.buildSignedDocumentHtml({ Title: 'VPA', Version: '1.0', EffectiveDate: '', Body: '# VPA\nText' }, {},
    [{ role: 'Volunteer', name: 'Ann Lee', signedAt: '2026-10-09 10:00 UTC', image: 'data:image/png;base64,AAAA' },
     { role: 'For Healthcare for Justice', name: 'Anthony Walls', title: 'CEO', signedAt: 'x', image: 'javascript:alert(1)' }], 'record SIG-00001');
  assert.match(html, /VPA · version 1\.0/);
  assert.match(html, /<img class="sig" src="data:image\/png;base64,AAAA">/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /Anthony Walls, CEO/);
});

test('documents per credential follow the matrix', () => {
  assert.deepEqual(plain(app.documentsFor(vol())), ['background_auth', 'phi_policy', 'confidentiality', 'vpa', 'attestation']);
  assert.deepEqual(plain(app.documentsFor(vol({ Credential: 'NP', Telehealth: true }))),
    ['background_auth', 'phi_policy', 'confidentiality', 'vpa', 'add_a_supervision', 'add_b_telehealth', 'attestation']);
  assert.deepEqual(plain(app.documentsFor(vol({ Credential: 'RN' }))), ['background_auth', 'phi_policy', 'confidentiality', 'attestation']);
  assert.ok(app.documentsFor(vol({ Credential: 'AMFT' })).includes('bh_agreement'));
});

test('HIPAA needs both the policy acknowledgment and the confidentiality agreement', () => {
  const v = vol();
  const ack = { DocKey: 'phi_policy', Status: 'Complete' };
  const conf = { DocKey: 'confidentiality', Status: 'Complete', PdfUrl: 'u' };
  assert.equal(app.requirementsSatisfiedBy([ack], v).hipaa, undefined);
  assert.equal(app.requirementsSatisfiedBy([conf], v).hipaa, undefined);
  assert.equal(app.requirementsSatisfiedBy([ack, conf], v).hipaa.PdfUrl, 'u');
  assert.equal(app.requirementsSatisfiedBy([{ DocKey: 'vpa', Status: 'Awaiting HFJ' }], v).vpa, undefined);
  const bh = vol({ Credential: 'LMFT', Telehealth: true });
  const s = app.requirementsSatisfiedBy([{ DocKey: 'bh_agreement', Status: 'Complete' }], bh);
  assert.ok(s.bh_agreement && s.bh_add_a_telehealth);
  assert.equal(app.requirementsSatisfiedBy([{ DocKey: 'bh_agreement', Status: 'Complete' }], vol({ Credential: 'LMFT' })).bh_add_a_telehealth, undefined);
});

test('form fields: trainee-only fields, required checks, nothing undeclared kept', () => {
  assert.equal(app.formFieldsFor('bh_agreement', vol({ Credential: 'LMFT' })).length, 0);
  assert.equal(app.formFieldsFor('bh_agreement', vol({ Credential: 'AMFT' })).length, 6);
  const r = app.cleanFormValues('background_auth', vol(), { LegalName: ' Ann Lee ', DateOfBirth: 'yesterday', Email: 'x', Evil: 'y' });
  assert.equal(r.values.LegalName, 'Ann Lee');
  assert.equal(r.values.Evil, undefined);
  assert.ok(r.errors.some((e) => /Date of birth must be a date/.test(e)));
  assert.ok(r.errors.some((e) => /Current address is required/.test(e)));
  assert.ok(r.errors.some((e) => /Email address must be an email/.test(e)));
});

test('onboarding checklist statuses', () => {
  const v = vol({ ProfileConfirmedAt: '2026-10-01T00:00:00Z' });
  const docs = { phi_policy: { Title: 'PHI' }, confidentiality: { Title: 'Conf' }, background_auth: { Title: 'BG' }, vpa: { Title: 'VPA' } };
  const reqs = app.requiredDefsFor(v).map((d) => ({ RequirementKey: d.key, Status: d.key === 'background_auth' ? 'Complete' : 'Not started' }));
  reqs.find((r) => r.RequirementKey === 'bg_auth').Status = 'Complete';
  let t = plain(app.onboardingTasks(v, reqs, [], [{ DocKey: 'vpa', Kind: 'sign', Status: 'Awaiting HFJ', SignedAt: 'x' }], docs, '2026-10-09', {}));
  const by = (k) => t.find((x) => x.key === k);
  assert.equal(by('profile').status, 'done');
  assert.equal(by('license-0').status, 'todo');
  assert.equal(by('doc-background_auth').status, 'done', 'uploaded by HFJ counts');
  assert.equal(by('doc-background_auth').note, 'On file with HFJ.');
  assert.equal(by('doc-vpa').status, 'waiting');
  assert.equal(by('doc-attestation').status, 'unavailable', 'attestation text not published');
  assert.equal(by('req-malpractice').status, 'hfj');
  assert.equal(app.volunteerPartComplete(t), false);

  const cred = { CredentialID: 'C1', Type: 'CA Physician & Surgeon License', ExpirationDate: '2027-01-01', UploadedDocUrl: 'u' };
  t = plain(app.onboardingTasks(v, reqs, [cred], [], docs, '2026-10-09', {}));
  assert.equal(t.find((x) => x.key === 'license-0').status, 'waiting');
  t = plain(app.onboardingTasks(vol({ Credential: 'RN' }), [], [], [], docs, '2026-10-09', {}));
  assert.equal(t.find((x) => x.key === 'req-nurse_agreement').status, 'unavailable');
});

test('uploads: type is decided by the bytes, and must match the name', () => {
  const pdf = [...Buffer.from('%PDF-1.7 hello')];
  const png = [0x89, ...Buffer.from('PNG\r\n\x1a\n')];
  assert.equal(app.validateUpload('license.pdf', 'application/pdf', pdf).mime, 'application/pdf');
  assert.equal(app.validateUpload('shot.PNG', '', png.map((b) => (b > 127 ? b - 256 : b))).type, 'png');
  assert.throws(() => app.validateUpload('evil.pdf', 'application/pdf', [...Buffer.from('MZ\x90\x00')]), /Only PDF or image/);
  assert.throws(() => app.validateUpload('license.png', 'image/png', pdf), /doesn't match/);
  assert.throws(() => app.validateUpload('license.pdf', 'text/html', pdf), /doesn't match/);
  assert.throws(() => app.validateUpload('big.pdf', 'application/pdf', { length: 6 * 1024 * 1024 }), /larger than 5 MB/);
});

test('bulk invite list parsing', () => {
  const r = plain(app.parseInviteList('Name\tEmail\tCredential\nAnn Lee\tAnn@Example.com\tMD\nDo Nguyen, do@example.com, FNP-C\nNo Email, MD\nBo, bo@example.com, wizard\nAnn Again, ann@example.com, DO\n\n'));
  assert.deepEqual(r.rows, [
    { Name: 'Ann Lee', Email: 'ann@example.com', Credential: 'MD' },
    { Name: 'Do Nguyen', Email: 'do@example.com', Credential: 'NP' }
  ]);
  assert.equal(r.errors.length, 3);
});

test('tokens and file names', () => {
  assert.equal(app.bytesToHex([0, 15, -1, 127]), '000fff7f');
  assert.equal(app.isTokenShaped('a'.repeat(64)), true);
  assert.equal(app.isTokenShaped('a'.repeat(63) + 'Z'), false);
  assert.equal(app.documentFileName('2026-10-09', vol({ Name: 'Ann Marie Lee' }), 'Addendum A: NP/PA', '1.0', 'pdf'),
    '2026-10-09 Lee, Ann Marie – Addendum A- NP-PA v1.0.pdf');
  assert.equal(app.volunteerFolderName(vol()), 'Lee, Ann (HFJV-00001)');
});

test('sharing guard: only named admins on the admin domain, never public', () => {
  const admins = ['anthony@hfjvc.org', 'outsider@gmail.com'];
  const ok = { role: 'writer', type: 'user', emailAddress: 'Anthony@hfjvc.org' };
  assert.equal(app.assertAllowedShare(ok, admins, 'hfjvc.org'), true);
  const bad = [
    { role: 'reader', type: 'anyone' },
    { role: 'reader', type: 'anyone', emailAddress: 'anthony@hfjvc.org' },
    { role: 'writer', type: 'domain', emailAddress: 'anthony@hfjvc.org' },
    { role: 'writer', type: 'group', emailAddress: 'anthony@hfjvc.org' },
    { role: 'owner', type: 'user', emailAddress: 'anthony@hfjvc.org' },
    { role: 'writer', type: 'user', emailAddress: 'outsider@gmail.com' },
    { role: 'writer', type: 'user', emailAddress: 'stranger@hfjvc.org' },
    Object.assign({ allowFileDiscovery: true }, ok)
  ];
  for (const p of bad) assert.throws(() => app.assertAllowedShare(p, admins, 'hfjvc.org'), /Refusing to share/, JSON.stringify(p));
  assert.throws(() => app.assertAllowedShare(ok, admins, ''), /Refusing/);
});

test('source: Drive sharing happens in exactly one place, behind the guard', async () => {
  const fs = await import('node:fs');
  const dir = new URL('../src/', import.meta.url);
  const all = fs.readdirSync(dir).filter((f) => /\.(gs|html)$/.test(f))
    .map((f) => [f, fs.readFileSync(new URL(f, dir), 'utf8')]);
  const hits = (re) => all.filter(([, src]) => re.test(src)).map(([f]) => f);
  assert.deepEqual(hits(/Permissions\.(create|update)/), ['DriveStore.gs']);
  assert.deepEqual(hits(/['"]anyone['"]|ANYONE_WITH_LINK|setSharing|addViewer|addEditor|allowFileDiscovery|publishAuto/), []);
  const drive = all.find(([f]) => f === 'DriveStore.gs')[1];
  assert.equal((drive.match(/Permissions\.create/g) || []).length, 1);
  assert.match(drive, /assertAllowedShare\(permission, admins, domain\);\s*Drive\.Permissions\.create\(permission/);
});
