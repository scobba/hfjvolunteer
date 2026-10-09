/** Web app entry point and the spreadsheet menu. */

function doGet() {
  var email = currentEmail_();
  var error = '';
  try {
    requireAdmin_();
  } catch (e) {
    error = e.message;
  }
  var t = HtmlService.createTemplateFromFile('Index');
  t.error = error;
  t.email = email;
  return t.evaluate()
    .setTitle('HFJ Volunteers')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('HFJ Volunteers')
    .addItem('Set up tabs', 'setupTabs')
    .addItem('Install daily reminder trigger', 'installTriggers')
    .addSeparator()
    .addItem('Migration: dry run (writes MigrationReport)', 'menuMigrationDryRun')
    .addItem('Migration: import volunteers', 'menuMigrationCommit')
    .addSeparator()
    .addItem('Run daily job now', 'dailyJob')
    .addToUi();
}

function menuMigrationDryRun() {
  var n = migrationDryRun();
  SpreadsheetApp.getUi().alert(n + ' volunteers parsed. Review the MigrationReport tab before importing.');
}

function menuMigrationCommit() {
  var ui = SpreadsheetApp.getUi();
  var ok = ui.alert('Import volunteers', 'Import everyone marked "Create" on the MigrationReport? ' +
    'Run the dry run first if you changed anything.', ui.ButtonSet.OK_CANCEL);
  if (ok !== ui.Button.OK) return;
  var res = migrationCommit();
  ui.alert(res.created + ' created, ' + res.skipped + ' skipped (already in Volunteers).');
}
