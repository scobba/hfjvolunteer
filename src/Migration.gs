/**
 * One-time import of DD_BPM_Response_Vol_List (spec §3, migration notes).
 *
 * The script can only open its own Sheet, so the old roster's tabs are first
 * copied in (right-click tab → Copy to → Existing spreadsheet). Copies arrive
 * named "Copy of <tab>"; those are read unless Settings.MigrationSourceTabs
 * names the tabs explicitly. Delete the copies once the import is done.
 *
 * Run migrationDryRun() first: it writes a MigrationReport tab showing how
 * every source column was mapped and every row will be imported, with
 * warnings. Fix the mapping (MIGRATION_HEADER_OVERRIDES below) or the source
 * until the report reads right, then run migrationCommit().
 *
 * Re-running commit is safe: volunteers whose email (or, without email, name)
 * already exists are skipped.
 */

/**
 * Exact source header → target, checked before the keyword rules. Targets:
 *   'field:<VolunteersColumn>', 'req:<requirementKey>', 'req:agreement'
 *   (the category's main agreement), 'flag:Telehealth', 'flag:Precepting',
 *   'name:first', 'name:last', 'notes' (keep as a note), 'skip'.
 * Example: 'Signed VPA?': 'req:vpa'
 */
var MIGRATION_HEADER_OVERRIDES = {};

/** Keyword rules on the normalized header (lowercase, letters and digits only). First match wins. */
var MIGRATION_RULES = [
  [function (h) { return /hfjgoogle|googleacc|gdrive|athena/.test(h); }, 'req:athena'],
  [function (h) { return /frequency/.test(h) && /call/.test(h); }, 'field:CallTargetPerMonth'],
  [function (h) { return /background/.test(h) && /auth/.test(h); }, 'req:bg_auth'],
  [function (h) { return /background/.test(h); }, 'req:bg_determination'],
  [function (h) { return /hipaa|confidential/.test(h); }, 'req:hipaa'],
  [function (h) { return /malpractice/.test(h); }, 'req:malpractice'],
  [function (h) { return /addendumb|addendum.*telehealth/.test(h); }, 'req:add_b_telehealth'],
  [function (h) { return /addendumc|addendum.*educat/.test(h); }, 'req:add_c_education'],
  [function (h) { return /addenduma/.test(h); }, 'req:add_a_supervision'],
  [function (h) { return /agreement/.test(h); }, 'req:agreement'],
  [function (h) { return /supervisor/.test(h); }, 'req:supervisor'],
  [function (h) { return /school|program/.test(h); }, 'req:school'],
  [function (h) { return /telehealth/.test(h); }, 'flag:Telehealth'],
  [function (h) { return /precept/.test(h); }, 'flag:Precepting'],
  [function (h) { return /signal/.test(h); }, 'field:OnSignal'],
  [function (h) { return /spanish/.test(h); }, 'field:SpanishFluency'],
  [function (h) { return /email/.test(h); }, 'field:Email'],
  [function (h) { return /phone|cell|mobile/.test(h); }, 'field:Phone'],
  [function (h) { return /preferred|nickname|goesby/.test(h); }, 'field:PreferredName'],
  [function (h) { return /firstname/.test(h); }, 'name:first'],
  [function (h) { return /lastname|surname/.test(h); }, 'name:last'],
  [function (h) { return /name/.test(h); }, 'field:Name'],
  [function (h) { return /credential|degree|licensetype|profession|title|role/.test(h); }, 'field:Credential'],
  [function (h) { return /folder|drivelink|url/.test(h); }, 'field:DriveFolderUrl'],
  [function (h) { return /status|active/.test(h); }, 'field:Status'],
  [function (h) { return /startdate|started|joined/.test(h); }, 'field:StartDate'],
  [function (h) { return /note|comment/.test(h); }, 'field:Notes'],
  [function (h) { return /^timestamp$/.test(h); }, 'skip']
];

/** Requirements whose source cell may hold a name or other text rather than a checkbox. */
var DETAIL_REQUIREMENTS = ['supervisor', 'school', 'bg_determination'];

var MAIN_AGREEMENT = { LIP: 'vpa', NurseCNA: 'nurse_agreement', BehavioralHealth: 'bh_agreement' };

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapHeader(header) {
  if (Object.prototype.hasOwnProperty.call(MIGRATION_HEADER_OVERRIDES, header)) {
    return MIGRATION_HEADER_OVERRIDES[header];
  }
  var h = normalizeHeader(header);
  if (!h) return 'skip';
  for (var i = 0; i < MIGRATION_RULES.length; i++) {
    if (MIGRATION_RULES[i][0](h)) return MIGRATION_RULES[i][1];
  }
  return 'notes';
}

function categoryForTab(tabName) {
  var t = normalizeHeader(tabName);
  if (/therap|behavior|bh|counsel|mental/.test(t)) return 'BehavioralHealth';
  if (/nurse|cna|rn/.test(t)) return 'NurseCNA';
  if (/lip|provider|physician|md|clinician/.test(t)) return 'LIP';
  return '';
}

/** Date cells arrive from the runner as { __date: 'yyyy-MM-dd' } so this file stays pure. */
function isDateCell(v) {
  return !!(v && typeof v === 'object' && v.__date);
}

function cellText(v) {
  if (v === null || v === undefined) return '';
  if (isDateCell(v)) return v.__date;
  return String(v).trim();
}

/** Y / y / Yes / TRUE / checked → true; N / No / FALSE / blank → false; anything else → null. */
function parseBool(v) {
  if (v === true || v === false) return v;
  var s = cellText(v).toLowerCase();
  if (s === '') return false;
  if (/^(y|yes|true|x|✓|✔|done|complete|completed)$/.test(s)) return true;
  if (/^(n|no|false|-|n\/a|na)$/.test(s)) return false;
  return null;
}

/** Normalizes to (805) 208-4439. Handles numbers stored as floats (8052084439.0). */
function normalizePhone(v) {
  var raw = cellText(v);
  if (!raw) return { value: '', warning: '' };
  var digits = raw.replace(/\.0+$/, '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length === 10) {
    return { value: '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6),
      warning: /\.0+$/.test(raw) || typeof v === 'number' ? 'Phone was stored as a number; normalized' : '' };
  }
  return { value: raw, warning: 'Phone "' + raw + '" is not a 10-digit number; kept as is' };
}

/**
 * CallTargetPerMonth. Only plain whole numbers are trusted. Dates are the
 * Sheets autoformat of "1/2" (meaning 1–2 per month) and must be re-collected,
 * not parsed (spec §3).
 */
function parseCallTarget(v) {
  if (v === '' || v === null || v === undefined) return { value: '', warning: '' };
  if (isDateCell(v) || /^\d{4}-\d{2}-\d{2}/.test(cellText(v)) || /\d+\s*\/\s*\d+/.test(cellText(v))) {
    return { value: '', warning: 'Call frequency "' + cellText(v) + '" was autoformatted as a date — re-collect' };
  }
  var s = cellText(v);
  if (/^\d+(\.0+)?$/.test(s)) return { value: parseInt(s, 10), warning: '' };
  return { value: '', warning: 'Call frequency "' + s + '" is not a whole number — re-collect' };
}

/** Free-text credential → a VOLUNTEER_CREDENTIALS key, or '' when unsure. */
function parseCredential(v) {
  var s = cellText(v).toUpperCase().replace(/\./g, '');
  if (!s) return '';
  var rules = [
    [/\bAMFT\b|\bMFT ?(INTERN|ASSOC)/, 'AMFT'], [/\bASW\b/, 'ASW'], [/\bAPCC\b/, 'APCC'],
    [/PSYCH(OLOGICAL)? ?ASSOC/, 'Psych Associate'],
    [/\bLMFT\b/, 'LMFT'], [/\bLCSW\b/, 'LCSW'], [/\bLPCC\b/, 'LPCC'], [/\bLEP\b/, 'LEP'],
    [/\bPSYD\b|PSYCHOLOGIST/, 'Psychologist'],
    [/\bMD\b|PHYSICIAN/, 'MD'], [/\bDO\b/, 'DO'],
    [/\b(F|A|PM|W)?NP(-C)?\b|NURSE PRACTITIONER/, 'NP'],
    [/\bPA(-C)?\b|PHYSICIAN ASSISTANT/, 'PA'],
    [/\bCNA\b|NURSE ASSISTANT/, 'CNA'], [/\bRN\b|REGISTERED NURSE/, 'RN']
  ];
  for (var i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
  return '';
}

function parseStatus(v) {
  var b = parseBool(v);
  if (b === true) return 'Active';
  var s = cellText(v).toLowerCase();
  for (var i = 0; i < VOLUNTEER_STATUSES.length; i++) {
    if (s === VOLUNTEER_STATUSES[i].toLowerCase()) return VOLUNTEER_STATUSES[i];
  }
  if (b === false && s) return 'Inactive';
  return '';
}

/**
 * Parses one source tab (values[0] = headers). Pure.
 * Returns { tab, category, columns: [{header, target}], records: [...] }.
 */
function parseSourceTab(tabName, values) {
  var headers = values[0] || [];
  var tabCategory = categoryForTab(tabName);
  var columns = headers.map(function (h) { return { header: cellText(h), target: mapHeader(cellText(h)) }; });
  var records = [];

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (c) { return cellText(c) === ''; })) continue;

    var rec = { tab: tabName, row: r + 1, fields: {}, reqs: {}, notes: [], warnings: [] };
    var first = '', last = '';

    columns.forEach(function (col, i) {
      var v = row[i];
      var text = cellText(v);
      var t = col.target;
      if (t === 'skip') return;
      if (t === 'notes') { if (text) rec.notes.push(col.header + ': ' + text); return; }
      if (t === 'name:first') { first = text; return; }
      if (t === 'name:last') { last = text; return; }
      if (t.indexOf('flag:') === 0) {
        var fb = parseBool(v);
        if (fb === null) rec.warnings.push(col.header + ' "' + text + '" is not yes/no');
        rec.fields[t.slice(5)] = rec.fields[t.slice(5)] || fb === true;
        return;
      }
      if (t.indexOf('req:') === 0) {
        addRequirementCell(rec, t.slice(4), col.header, v);
        return;
      }
      var field = t.slice(6);
      if (field === 'CallTargetPerMonth') {
        var ct = parseCallTarget(v);
        rec.fields.CallTargetPerMonth = ct.value;
        if (ct.warning) rec.warnings.push(ct.warning);
      } else if (field === 'Phone') {
        var ph = normalizePhone(v);
        rec.fields.Phone = ph.value;
        if (ph.warning) rec.warnings.push(ph.warning);
      } else if (field === 'OnSignal') {
        var sb = parseBool(v);
        if (sb === null) rec.warnings.push(col.header + ' "' + text + '" is not yes/no');
        rec.fields.OnSignal = sb === true;
      } else if (field === 'Status') {
        var st = parseStatus(v);
        if (text && !st) rec.warnings.push('Status "' + text + '" not recognized; defaulting to Active');
        if (st) rec.fields.Status = st;
      } else if (field === 'StartDate') {
        if (isDateCell(v)) rec.fields.StartDate = v.__date;
        else if (text) rec.notes.push(col.header + ': ' + text);
      } else if (field === 'Notes') {
        if (text) rec.notes.push(text);
      } else if (text) {
        rec.fields[field] = rec.fields[field] ? rec.fields[field] + '; ' + text : text;
      }
    });

    if (!rec.fields.Name && (first || last)) rec.fields.Name = (first + ' ' + last).trim();
    if (!rec.fields.Name) { rec.warnings.push('No name — row skipped'); rec.skip = true; }

    var credText = rec.fields.Credential || '';
    var cred = parseCredential(credText);
    rec.fields.Credential = cred;
    var credCategory = cred ? categoryForCredential(cred) : '';
    rec.fields.Category = credCategory || tabCategory;
    if (!cred) {
      rec.warnings.push(credText ? 'Credential "' + credText + '" not recognized — set it by hand'
        : 'No credential column/value — set it by hand');
      if (credText) rec.notes.push('Credential (original): ' + credText);
    } else if (tabCategory && credCategory !== tabCategory) {
      rec.warnings.push('Credential ' + cred + ' is ' + credCategory + ' but row is on tab "' + tabName + '"');
    }
    if (!rec.fields.Email) rec.warnings.push('No email');
    if (!rec.fields.Status) rec.fields.Status = 'Active';
    resolveRequirementKeys(rec);
    records.push(rec);
  }
  return { tab: tabName, category: tabCategory, columns: columns, records: records };
}

/** Several source columns can feed one requirement (the two Google-account columns → Athena): all must be true. */
function addRequirementCell(rec, key, header, v) {
  var text = cellText(v);
  var entry = rec.reqs[key] || { complete: true, detail: '', date: '', sources: [] };
  entry.sources.push(header);
  var b = parseBool(v);
  if (isDateCell(v)) {
    entry.date = v.__date;
  } else if (b === null) {
    if (DETAIL_REQUIREMENTS.indexOf(key) !== -1) {
      entry.detail = text;
    } else {
      entry.complete = false;
      rec.warnings.push(header + ' "' + text + '" is not yes/no — left incomplete');
    }
  } else if (b === false) {
    entry.complete = false;
  }
  rec.reqs[key] = entry;
}

/** Turns category-relative keys into concrete ones and drops items the volunteer's matrix row doesn't have. */
function resolveRequirementKeys(rec) {
  var out = {};
  var group = rec.fields.Credential ? credentialInfo(rec.fields.Credential).group : '';
  var bh = rec.fields.Category === 'BehavioralHealth';
  Object.keys(rec.reqs).forEach(function (key) {
    var k = key;
    if (k === 'agreement') k = MAIN_AGREEMENT[rec.fields.Category] || '';
    // BH paperwork's Addendum A is the telehealth addendum.
    if (bh && (k === 'add_a_supervision' || k === 'add_b_telehealth')) k = 'bh_add_a_telehealth';
    if (!k) { rec.warnings.push('Agreement column with unknown category — not imported'); return; }
    var e = rec.reqs[key];
    if (k === 'bg_determination' && e.complete) {
      var d = e.detail.toLowerCase();
      if (/not ?cleared/.test(d)) e.detail = 'Not cleared';
      else if (/conditional/.test(d)) e.detail = 'Conditional';
      else if (/cleared|pass/.test(d)) e.detail = 'Cleared';
      else { e.detail = ''; e.confirm = true; }
    }
    if (k === 'add_b_telehealth' || k === 'bh_add_a_telehealth') {
      if (e.complete) rec.fields.Telehealth = true;
    }
    if (k === 'add_c_education' && e.complete) rec.fields.Precepting = true;
    if (group) {
      var def = requirementDef(k);
      if (def && def.groups.indexOf(group) === -1) {
        if (e.complete) rec.warnings.push(def.label + ' marked done but not required for ' + rec.fields.Credential);
        return;
      }
    }
    out[k] = e;
  });
  rec.reqs = out;
}

/** Merges records across tabs: same email (or same name when there is no email) → one volunteer. */
function mergeRecords(records) {
  var byKey = {}, order = [];
  records.forEach(function (rec) {
    if (rec.skip) return;
    var key = (rec.fields.Email || '').toLowerCase() || 'name:' + rec.fields.Name.toLowerCase();
    var into = byKey[key];
    if (!into) { byKey[key] = rec; order.push(key); return; }
    Object.keys(rec.fields).forEach(function (f) {
      var a = into.fields[f], b = rec.fields[f];
      if (a === '' || a === undefined || a === false) into.fields[f] = b;
    });
    Object.keys(rec.reqs).forEach(function (k) {
      var a = into.reqs[k], b = rec.reqs[k];
      if (!a) into.reqs[k] = b;
      else into.reqs[k] = { complete: a.complete || b.complete, detail: a.detail || b.detail,
        date: a.date || b.date, sources: a.sources.concat(b.sources), confirm: a.confirm && b.confirm };
    });
    into.notes = into.notes.concat(rec.notes);
    into.warnings = into.warnings.concat(['Also listed on "' + rec.tab + '" row ' + rec.row + '; merged'], rec.warnings);
  });
  return order.map(function (k) { return byKey[k]; });
}

// ---------------------------------------------------------------- runner (Apps Script only)

var COPY_PREFIX = 'Copy of ';

/** Source tab names: Settings.MigrationSourceTabs, or every "Copy of …" tab. Pure. */
function migrationSourceTabNames(allNames, setting) {
  var named = String(setting || '').split(',').map(function (s) { return s.trim(); }).filter(String);
  if (named.length) return named;
  return allNames.filter(function (n) { return n.indexOf(COPY_PREFIX) === 0; });
}

function readMigrationSource_() {
  var ss = getSpreadsheet_();
  var names = migrationSourceTabNames(ss.getSheets().map(function (s) { return s.getName(); }),
    getSettings_().MigrationSourceTabs);
  if (!names.length) {
    throw new Error('No old roster tabs found. Copy the three tabs of DD_BPM_Response_Vol_List into this Sheet ' +
      '(right-click each tab → Copy to → Existing spreadsheet), or list them in Settings → MigrationSourceTabs.');
  }
  var tz = ss.getSpreadsheetTimeZone();
  return names.map(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) throw new Error('Tab "' + name + '" (from MigrationSourceTabs) does not exist.');
    var values = sh.getDataRange().getValues().map(function (row) {
      return row.map(function (c) {
        return c instanceof Date ? { __date: Utilities.formatDate(c, tz, 'yyyy-MM-dd') } : c;
      });
    });
    var label = name.indexOf(COPY_PREFIX) === 0 ? name.slice(COPY_PREFIX.length) : name;
    return parseSourceTab(label, values);
  });
}

function migrationDryRun() {
  var actor = requireAdmin_();
  var tabs = readMigrationSource_();
  var merged = mergeRecords([].concat.apply([], tabs.map(function (t) { return t.records; })));
  var existing = existingVolunteerKeys_();
  writeMigrationReport_(tabs, merged, existing);
  logAudit_(actor, 'migration.dryRun', 'Migration', '', merged.length + ' volunteers parsed');
  return merged.length;
}

function migrationCommit() {
  var actor = requireAdmin_();
  var tabs = readMigrationSource_();
  var merged = mergeRecords([].concat.apply([], tabs.map(function (t) { return t.records; })));
  var existing = existingVolunteerKeys_();
  var created = 0, skipped = 0;
  merged.forEach(function (rec) {
    if (existing[migrationKey_(rec.fields)]) { skipped++; return; }
    var f = rec.fields;
    var notes = rec.notes.slice();
    if (rec.warnings.length) notes.push('Import warnings: ' + rec.warnings.join(' | '));
    var v = createVolunteer_({
      Name: f.Name, PreferredName: f.PreferredName || '', Credential: f.Credential,
      Category: f.Category, Email: f.Email || '', Phone: f.Phone || '',
      SpanishFluency: f.SpanishFluency || '', Notes: notes.join('\n'),
      Status: f.Status, CallTargetPerMonth: f.CallTargetPerMonth, OnSignal: !!f.OnSignal,
      Telehealth: !!f.Telehealth, Precepting: !!f.Precepting,
      DriveFolderUrl: f.DriveFolderUrl || '', StartDate: f.StartDate || ''
    }, actor, { allowUnknownCredential: true, source: 'migration' });
    applyMigratedRequirements_(v, rec.reqs, actor);
    created++;
  });
  logAudit_(actor, 'migration.commit', 'Migration', '', created + ' created, ' + skipped + ' skipped (already present)');
  return { created: created, skipped: skipped };
}

function migrationKey_(f) {
  return (f.Email || '').toLowerCase() || 'name:' + String(f.Name || '').toLowerCase();
}

function existingVolunteerKeys_() {
  var out = {};
  readRows_(TABS.VOLUNTEERS).forEach(function (v) { out[migrationKey_(v)] = true; });
  return out;
}

function applyMigratedRequirements_(v, reqs, actor) {
  withLock_(function () { applyMigratedRequirementsLocked_(v, reqs, actor); });
}

function applyMigratedRequirementsLocked_(v, reqs, actor) {
  var rows = readRows_(TABS.REQUIREMENTS).filter(function (r) { return r.VolunteerID === v.VolunteerID; });
  rows.forEach(function (row) {
    var e = reqs[row.RequirementKey];
    if (!e || !e.complete) return;
    var note = 'Migrated from DD_BPM_Response_Vol_List (' + e.sources.join(', ') + ')';
    if (e.confirm) note += '. Old roster had a checkbox only — confirm the determination.';
    updateRow_(TABS.REQUIREMENTS, row._row, {
      Status: 'Complete', CompletedDate: e.date || '', CompletedBy: 'Migration',
      Detail: e.detail || '', Notes: note, UpdatedAt: new Date(), UpdatedBy: actor.email
    });
  });
  afterChange_(v.VolunteerID, actor);
}

function writeMigrationReport_(tabs, merged, existing) {
  var ss = getSpreadsheet_();
  var sh = ss.getSheetByName('MigrationReport') || ss.insertSheet('MigrationReport');
  sh.clear();
  var out = [['Column mapping'], ['Source tab', 'Source column', 'Maps to']];
  tabs.forEach(function (t) {
    t.columns.forEach(function (c) { out.push([t.tab, c.header, c.target]); });
  });
  out.push([''], ['Volunteers'], ['Action', 'Source', 'Name', 'Email', 'Credential', 'Category', 'Status',
    'Phone', 'CallTargetPerMonth', 'Telehealth', 'Precepting', 'Requirements marked complete', 'Notes', 'Warnings']);
  merged.forEach(function (rec) {
    var f = rec.fields;
    var done = Object.keys(rec.reqs).filter(function (k) { return rec.reqs[k].complete; });
    out.push([existing[migrationKey_(f)] ? 'Skip (exists)' : 'Create', rec.tab + ' row ' + rec.row,
      f.Name, f.Email || '', f.Credential, f.Category, f.Status, f.Phone || '',
      f.CallTargetPerMonth === '' || f.CallTargetPerMonth === undefined ? '' : f.CallTargetPerMonth,
      !!f.Telehealth, !!f.Precepting, done.join(', '), rec.notes.join(' | '), rec.warnings.join(' | ')]);
  });
  var width = 14;
  var grid = out.map(function (r) { while (r.length < width) r.push(''); return r; });
  sh.getRange(1, 1, grid.length, width).setNumberFormat('@').setValues(grid);
  sh.setFrozenRows(0);
  ss.setActiveSheet(sh);
}
