import crypto from 'node:crypto';

// A small in-memory stand-in for the Apps Script services the app uses,
// enough to run setup → roster edits → migration → daily job end to end.
// Mimics Sheets turning 'yyyy-MM-dd' strings into Dates and "1.0" into the number 1
// unless the cell is plain text. Sheet.appendRow ignores formats, which is the
// pessimistic reading of what the real one did to Signatures.DocVersion.

// One Date class for both the fake sheets and the app, as in a single Apps Script runtime.
let clock = '2026-10-09';
/** Moves the fake clock: 'yyyy-MM-dd' (noon UTC) or a full ISO time. */
export function setClock(c) { clock = c; }

export class GasDate extends Date {
  constructor(...a) { if (a.length) super(...a); else super(GasDate.now()); }
  static now() { return Date.parse(clock.length > 10 ? clock : clock + 'T12:00:00Z'); }
}

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.formats = {}; this.cellFormats = {}; this.maxRows = 1000; }
  getName() { return this.name; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return this.rows.reduce((m, r) => Math.max(m, r.length), 0); }
  getMaxRows() { return Math.max(this.maxRows, this.rows.length); }
  insertRowsAfter(_, n) { this.maxRows += n; }
  getRange(r, c, nr = 1, nc = 1) { return new Range(this, r, c, nr, nc); }
  getDataRange() { return this.getRange(1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  appendRow(values) { this.rows.push(values.map((v) => this.convert(v, null, null))); }
  deleteRow(r) { this.rows.splice(r - 1, 1); }
  setFrozenRows() {}
  clear() { this.rows = []; }
  convert(v, row, col) {
    const fmt = col === null ? undefined : (this.cellFormats[row + ',' + col] || this.formats[col]);
    if (typeof v !== 'string' || fmt === '@') return v;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new GasDate(v + 'T00:00:00Z');
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
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
      vals.forEach((v, j) => { this.sheet.rows[idx][this.c - 1 + j] = this.sheet.convert(v, idx + 1, this.c + j); });
    });
    return this;
  }
  setValue(v) { return this.setValues([[v]]); }
  setNumberFormats(formats) {
    formats.forEach((row, i) => row.forEach((f, j) => { this.sheet.cellFormats[(this.r + i) + ',' + (this.c + j)] = f; }));
    return this;
  }
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
  const files = {};
  const permissions = [];
  const props = {};
  let fileSeq = 0;
  const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const blob = (bytes, mime) => ({ bytes, mime, name: '', setName(n) { this.name = n; return this; } });
  const state = { user, effective: 'volunteers@hfjvc.org', triggers: [] };
  // Google Calendar: calendars by id, each with its events and who may use it
  // (acl: email → 'owner' | 'writer' | 'reader'). The script acts as state.effective.
  const calendars = {};
  let calSeq = 0, evSeq = 0;
  const canWrite = (cal) => ['owner', 'writer'].includes(cal.acl[state.effective]);
  const makeCalendar = (id, name, acl) => {
    const cal = { id, name, events: [], acl: acl || { [state.effective]: 'owner' },
      getId: () => id,
      getName: () => name,
      isOwnedByMe: () => cal.acl[state.effective] === 'owner',
      createEvent(title, start, end, opts = {}) {
        if (!canWrite(cal)) throw new Error('You do not have permission to create events in this calendar.');
        const ev = { id: 'ev' + ++evSeq, title, start, end, opts, deleted: false,
          getId() { return this.id; }, getTitle() { return this.title; }, isAllDayEvent: () => false,
          getStartTime() { return this.start; },
          deleteEvent() { if (!canWrite(cal)) throw new Error('No permission'); this.deleted = true; } };
        cal.events.push(ev);
        return ev;
      },
      getEventById: (eid) => cal.events.find((e) => e.id === eid && !e.deleted) || null,
      getEvents: (start, end) => cal.events.filter((e) => !e.deleted && e.start < end && (e.end || e.start) > start),
    };
    calendars[id] = cal;
    return cal;
  };
  clock = today;
  return {
    main, sent, state, files, permissions, calendars, makeCalendar,
    globals: {
      Date: GasDate,
      Logger: { log() {} },
      CalendarApp: {
        getCalendarById: (id) => (calendars[id] && calendars[id].acl[state.effective] ? calendars[id] : null),
        createCalendar: (name) => makeCalendar('cal' + ++calSeq + '@group.calendar.google.com', name),
      },
      SpreadsheetApp: {
        getActiveSpreadsheet: () => main,
        openById: () => { throw new Error('spreadsheets.currentonly: openById is not allowed'); },
        flush() {},
      },
      PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
      Session: { getActiveUser: () => ({ getEmail: () => state.user }), getEffectiveUser: () => ({ getEmail: () => state.effective }) },
      LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
      Utilities: {
        formatDate: (d, tz, fmt) => {
          const iso = new Date(d.getTime()).toISOString();
          if (fmt === 'yyyy-MM-dd') return iso.slice(0, 10);
          if (fmt === 'yyyy-MM-dd HH:mm z') return iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
          throw new Error('fake formatDate: unsupported format ' + fmt);
        },
        getUuid: () => crypto.randomUUID(),
        parseDate: (str, tz, fmt) => {
          if (fmt !== 'yyyy-MM-dd HH:mm') throw new Error('fake parseDate: unsupported format ' + fmt);
          return new GasDate(str.replace(' ', 'T') + ':00Z');
        },
        DigestAlgorithm: { SHA_256: 'sha256' },
        Charset: { UTF_8: 'utf8' },
        computeDigest: (alg, s) => signed(crypto.createHash(alg).update(String(s), 'utf8').digest()),
        base64Decode: (s) => signed(Buffer.from(s, 'base64')),
        newBlob: (bytes, mime) => blob(bytes, mime),
      },
      HtmlService: {
        createHtmlOutput: (html) => ({ getAs: (mime) => Object.assign(blob([], mime), { html }) }),
      },
      Drive: {
        Files: {
          create: (resource, media) => {
            const id = 'file' + ++fileSeq;
            files[id] = Object.assign({ id }, resource, media ? { media } : {});
            return { id };
          },
        },
        Permissions: { create: (p, fileId) => { permissions.push(Object.assign({ fileId }, p)); return {}; } },
      },
      MailApp: { sendEmail: (m) => sent.push(m) },
      ScriptApp: {
        getService: () => ({ getUrl: () => 'https://script.google.com/a/macros/hfjvc.org/s/x/exec' }),
        getProjectTriggers: () => state.triggers.map((uid) => ({ getUniqueId: () => uid, getHandlerFunction: () => 'dailyJob' })),
      },
    },
  };
}
