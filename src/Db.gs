/**
 * Sheets as tables. Rows come back as plain objects keyed by header, with
 * dates as 'yyyy-MM-dd', timestamps as ISO strings and checkboxes as
 * booleans, plus `_row` (the 1-based sheet row) for updates.
 */

var ss_ = null;

/**
 * The Sheet this script is bound to — the only one it can open. The manifest
 * asks for spreadsheets.currentonly, so no other spreadsheet (the EHR's
 * included) is reachable from this project.
 */
function getSpreadsheet_() {
  if (ss_) return ss_;
  ss_ = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss_) throw new Error('No spreadsheet: this script must be bound to the HFJ Volunteers Sheet.');
  return ss_;
}

function sheet_(tab) {
  var sh = getSpreadsheet_().getSheetByName(tab);
  if (!sh) throw new Error('Tab "' + tab + '" is missing. Run HFJ Volunteers → Set up tabs.');
  return sh;
}

function columnTypes_(tab) {
  var out = {};
  (SCHEMAS[tab] || []).forEach(function (c) { out[c[0]] = c[1]; });
  return out;
}

function fromCell_(v, type, tz) {
  if (type === 'date') {
    if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return String(v || '').trim();
  }
  if (type === 'datetime') {
    if (v instanceof Date) return v.toISOString();
    return String(v || '');
  }
  if (type === 'bool') return v === true || String(v).toUpperCase() === 'TRUE';
  if (type === 'int') {
    if (v === '' || v === null) return '';
    var n = Number(v);
    return isNaN(n) ? '' : Math.round(n);
  }
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}

function toCell_(v, type) {
  if (v === undefined || v === null) return '';
  if (type === 'date') return isIsoDate(v) ? v : '';
  if (type === 'datetime') {
    if (v instanceof Date) return v;
    return v ? new Date(v) : '';
  }
  if (type === 'bool') return v === true;
  if (type === 'int') return v === '' ? '' : Math.round(Number(v)) || 0;
  return String(v);
}

function headers_(sh) {
  if (sh.getLastColumn() === 0) return [];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function readRows_(tab) {
  var sh = sheet_(tab);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0].map(String);
  var types = columnTypes_(tab);
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    if (row.every(function (c) { return c === '' || c === null || c === false; })) continue;
    var obj = { _row: r + 1 };
    headers.forEach(function (h, i) { if (h) obj[h] = fromCell_(row[i], types[h] || 'text', tz); });
    out.push(obj);
  }
  return out;
}

function rowValues_(tab, headers, obj) {
  var types = columnTypes_(tab);
  return headers.map(function (h) { return toCell_(obj[h], types[h] || 'text'); });
}

function appendRow_(tab, obj) {
  var sh = sheet_(tab);
  var headers = headers_(sh);
  var values = rowValues_(tab, headers, obj);
  sh.appendRow(values);
  var row = sh.getLastRow();
  var types = columnTypes_(tab);
  headers.forEach(function (h, i) {
    if (types[h] === 'bool') sh.getRange(row, i + 1).insertCheckboxes().setValue(values[i]);
  });
  return row;
}

/** Writes `patch` over the row at `rowIndex`, leaving other columns as they are. */
function updateRow_(tab, rowIndex, patch) {
  var sh = sheet_(tab);
  var headers = headers_(sh);
  var types = columnTypes_(tab);
  var tz = getSpreadsheet_().getSpreadsheetTimeZone();
  var current = sh.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  var merged = {};
  headers.forEach(function (h, i) { merged[h] = fromCell_(current[i], types[h] || 'text', tz); });
  Object.keys(patch).forEach(function (k) { if (k !== '_row') merged[k] = patch[k]; });
  sh.getRange(rowIndex, 1, 1, headers.length).setValues([rowValues_(tab, headers, merged)]);
}

function deleteRow_(tab, rowIndex) {
  sheet_(tab).deleteRow(rowIndex);
}

function findRow_(tab, field, value) {
  var rows = readRows_(tab);
  for (var i = 0; i < rows.length; i++) if (rows[i][field] === value) return rows[i];
  return null;
}

/** Next sequential ID like HFJV-00001. Call inside withLock_. */
function nextId_(tab, field, prefix) {
  var max = 0;
  readRows_(tab).forEach(function (r) {
    var m = String(r[field] || '').match(/(\d+)$/);
    if (m && String(r[field]).indexOf(prefix) === 0) max = Math.max(max, +m[1]);
  });
  return prefix + ('00000' + (max + 1)).slice(-5);
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** Strips fields the browser must never see. */
function publicRow_(row) {
  var out = {};
  Object.keys(row).forEach(function (k) {
    if (k !== '_row' && k !== 'AccessToken') out[k] = row[k];
  });
  return out;
}
