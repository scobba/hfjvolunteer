// A small in-memory stand-in for the Apps Script services the app uses,
// enough to run setup → roster edits → migration → daily job end to end.
// Mimics Sheets turning 'yyyy-MM-dd' strings into Dates unless the column is plain text.

// One Date class for both the fake sheets and the app, as in a single Apps Script runtime.
let clock = '2026-10-09';
export class GasDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(Date.parse(clock + 'T12:00:00Z')); }
  static now() { return Date.parse(clock + 'T12:00:00Z'); }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.formats = {}; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows() { return Math.max(1000, this.rows.length); }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(values) { this.rows.push(values.map((v, i) => this.convert(v, i + 1))); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  clear() { this.rows = []; }
  convert(v, col) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && this.formats[col] !== '@') return new GasDate(v + 'T00:00:00Z');
    return v;
  }
}

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = this.sheet.rows[this.r - 1 + i] || [];
      out.push(Array.from({ length: this.nc }, (_, j) => (row[this.c - 1 + j] === undefined ? '' : row[this.c - 1 + j])));
    }
    return out;
  }
  setValues(values) {
    values.forEach((vals, i) => {
      const idx = this.r - 1 + i;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      vals.forEach((v, j) => { this.sheet.rows[idx][this.c - 1 + j] = this.sheet.convert(v, this.c + j); });
    });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormat(f) { for (let j = 0; j < this.nc; j++) this.sheet.formats[this.c + j] = f; return this; }
  setFontWeight() { return this; }
  insertCheckboxes() { return this; }
}

class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
  getId() { return this.id; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id; }
  getSpreadsheetTimeZone() { return 'UTC'; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  getSheets() { return this.sheets.slice(); }
  insertSheet(n) { const s = new Sheet(n); this.sheets.push(s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter((x) => x !== s); }
  setActiveSheet() {}
}

export function fakeGas({ user = 'anthony@hfjvc.org', today = '2026-10-09' } = {}) {
  const main = new Spreadsheet('main');
  const sent = [];
  const state = { user };
  clock = today;
  return {
    main, sent, state,
    globals: {
      Date: GasDate,
      SpreadsheetApp: {
        getActiveSpreadsheet: () => main,
        openById: () => { throw new Error('spreadsheets.currentonly: openById is not allowed'); },
        flush() {},
      },
      Session: { getActiveUser: () => ({ getEmail: () => state.user }) },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Utilities: {
        formatDate: (d, tz, fmt) => {
          if (fmt !== 'yyyy-MM-dd') throw new Error('fake formatDate only does yyyy-MM-dd');
          return new Date(d.getTime()).toISOString().slice(0, 10);
        },
      },
      MailApp: { sendEmail: (m) => sent.push(m) },
      ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/hfjvc.org/s/x/exec' }) },
    },
  };
}
