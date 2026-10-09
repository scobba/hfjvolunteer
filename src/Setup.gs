/**
 * Creates or extends the tabs. Non-destructive: existing data and columns are
 * kept; missing tabs, columns and settings are added. Safe to re-run after
 * an update adds columns.
 */
function setupTabs() {
  var ss = getSpreadsheet_();
  var me = currentEmail_();

  var adminsSheet = ss.getSheetByName(TABS.ADMINS);
  var hasAdmins = adminsSheet && adminsSheet.getLastRow() > 1;
  if (hasAdmins) requireAdmin_();

  Object.keys(SCHEMAS).forEach(function (tab) {
    var sh = ss.getSheetByName(tab) || ss.insertSheet(tab);
    var have = headers_(sh).filter(String);
    var missing = SCHEMAS[tab].filter(function (c) { return have.indexOf(c[0]) === -1; });
    if (missing.length) {
      sh.getRange(1, have.length + 1, 1, missing.length).setValues([missing.map(function (c) { return c[0]; })]);
    }
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
    formatColumns_(sh, tab);
  });

  var settings = readRows_(TABS.SETTINGS);
  SETTING_DEFAULTS.forEach(function (d) {
    if (!settings.some(function (r) { return r.Key === d[0]; })) {
      appendRow_(TABS.SETTINGS, { Key: d[0], Value: d[1], Notes: d[2] });
    }
  });

  if (!hasAdmins && me) appendRow_(TABS.ADMINS, { Email: me, Name: '', Active: true });

  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);

  logAudit_(me || 'setup', 'setup.tabs', 'Spreadsheet', ss.getId(), 'Tabs created/extended');
}

/**
 * Plain-text format on text columns stops Sheets "helpfully" converting
 * values — the bug that turned "1/2" call frequencies into dates.
 */
function formatColumns_(sh, tab) {
  var headers = headers_(sh);
  var types = columnTypes_(tab);
  var rows = sh.getMaxRows() - 1;
  if (rows < 1) return;
  headers.forEach(function (h, i) {
    var range = sh.getRange(2, i + 1, rows, 1);
    var t = types[h];
    if (t === 'text') range.setNumberFormat('@');
    else if (t === 'date') range.setNumberFormat('yyyy-mm-dd');
    else if (t === 'datetime') range.setNumberFormat('yyyy-mm-dd hh:mm');
    else if (t === 'int') range.setNumberFormat('0');
    // Checkboxes are added per row on write (Db.appendRow_): a column of
    // pre-made FALSE checkboxes would count as data and push appends to the bottom.
  });
}

/** Installs the daily reminder trigger (replacing any earlier one). */
function installTriggers() {
  requireAdmin_();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(6).create();
  logAudit_(currentEmail_(), 'setup.triggers', 'Trigger', 'dailyJob', 'Daily at 06:00');
}
