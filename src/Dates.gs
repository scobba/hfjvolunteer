/**
 * Calendar-date helpers. Every date in the app's logic is a 'yyyy-MM-dd'
 * string, never a Date, so day arithmetic can't drift with time zones.
 * Pure: no Apps Script services, so these run under Node tests too.
 */

function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function dayNumber_(iso) {
  var p = iso.split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

function fromDayNumber_(n) {
  return new Date(n * 86400000).toISOString().slice(0, 10);
}

function addDays(iso, n) {
  return fromDayNumber_(dayNumber_(iso) + n);
}

/** Adds calendar months, clamping to the end of a shorter month (Jan 31 + 1 → Feb 28). */
function addMonths(iso, n) {
  var p = iso.split('-');
  var y = +p[0], m = +p[1] - 1 + n, d = +p[2];
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fromDayNumber_(Math.round(Date.UTC(y, m, Math.min(d, last)) / 86400000));
}

function addYears(iso, n) {
  return addMonths(iso, 12 * n);
}

/** Whole days from a to b; positive when b is later. */
function daysBetween(a, b) {
  return dayNumber_(b) - dayNumber_(a);
}
