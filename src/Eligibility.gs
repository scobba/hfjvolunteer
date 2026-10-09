/**
 * Eligibility (spec §7) and requirement status. Pure.
 *
 * A volunteer may take call on `onDate` only if they are Active, every
 * requirement for their credential is complete, and no credential has expired
 * or expires before `onDate`.
 */

/**
 * @param v        volunteer row
 * @param reqRows  this volunteer's Requirements rows
 * @param creds    this volunteer's Credentials rows
 * @param onDate   'yyyy-MM-dd' — the shift date, or today for "eligible now"
 * @param opts     { bgIntervalMonths: number|null, ignoreStatus: bool }
 */
function evaluateEligibility(v, reqRows, creds, onDate, opts) {
  opts = opts || {};
  var reasons = [];
  var items = [];

  if (!opts.ignoreStatus && v.Status !== 'Active') {
    reasons.push('Status is ' + (v.Status || 'blank'));
  }

  var info = credentialInfo(v.Credential);
  var defs = requiredDefsFor(v);
  if (!defs) {
    reasons.push('Unrecognized credential "' + (v.Credential || '') + '"');
    return { eligible: false, reasons: reasons, items: items, unknownCredential: true };
  }

  var rowsByKey = {};
  reqRows.forEach(function (r) { rowsByKey[r.RequirementKey] = r; });

  defs.forEach(function (def) {
    var row = rowsByKey[def.key] || null;
    var res;
    if (def.key === 'license') res = licenseStatus(info, creds, onDate);
    else if (def.key === 'attestation') res = attestationStatus(v, onDate);
    else if (def.key === 'bg_determination') res = backgroundStatus(row, onDate, opts.bgIntervalMonths);
    else res = manualStatus(row);
    var label = requirementLabel(def, info.group);
    items.push({ key: def.key, label: label, owner: def.owner, status: res.status,
      ok: res.ok, reason: res.reason || '', row: row });
    if (!res.ok) reasons.push(label + ': ' + (res.reason || res.status));
  });

  // Any other credential (BLS, DEA…) that has lapsed also blocks.
  var licenseTypes = [].concat.apply([], info.licenses);
  creds.forEach(function (c) {
    if (licenseTypes.indexOf(c.Type) !== -1 || !isIsoDate(c.ExpirationDate)) return;
    if (c.ExpirationDate < onDate && !isSuperseded(c, creds)) {
      reasons.push(c.Type + ' valid only through ' + c.ExpirationDate);
    }
  });

  return { eligible: reasons.length === 0, reasons: reasons, items: items, unknownCredential: false };
}

/** A lapsed credential row is superseded when a later row of the same type exists (a renewal). */
function isSuperseded(cred, creds) {
  return creds.some(function (o) {
    return o !== cred && o.Type === cred.Type && isIsoDate(o.ExpirationDate) &&
      o.ExpirationDate > cred.ExpirationDate;
  });
}

/** A credential counts toward eligibility only once an admin has verified it. */
function isVerified(cred) {
  return !!(cred.VerifiedBy && isIsoDate(cred.VerifiedDate));
}

/**
 * Verification is due when never done, or when it predates the volunteer's
 * latest annual attestation (spec §5: re-prompt at attestation).
 * Editing a verified credential's number or expiry clears verification.
 */
function needsVerification(cred, volunteer) {
  if (!isVerified(cred)) return true;
  return isIsoDate(volunteer.LastAttestationDate) && cred.VerifiedDate < volunteer.LastAttestationDate;
}

function licenseStatus(info, creds, onDate) {
  var problems = [];
  var anyExpired = false;
  info.licenses.forEach(function (slot) {
    var candidates = creds.filter(function (c) { return slot.indexOf(c.Type) !== -1; });
    var good = candidates.some(function (c) {
      return isVerified(c) && isIsoDate(c.ExpirationDate) && c.ExpirationDate >= onDate;
    });
    if (good) return;
    var name = slot.join(' or ');
    if (!candidates.length) { problems.push('no ' + name + ' on file'); return; }
    var verified = candidates.filter(isVerified);
    if (!verified.length) { problems.push(name + ' awaiting verification'); return; }
    var dated = verified.filter(function (c) { return isIsoDate(c.ExpirationDate); });
    if (!dated.length) { problems.push(name + ' has no expiration date recorded'); return; }
    var latest = dated.map(function (c) { return c.ExpirationDate; }).sort().pop();
    anyExpired = true;
    problems.push(name + ' valid only through ' + latest);
  });
  if (!problems.length) return { ok: true, status: 'Complete' };
  return { ok: false, status: anyExpired ? 'Expired' : 'Not started', reason: problems.join('; ') };
}

function attestationStatus(v, onDate) {
  if (!isIsoDate(v.LastAttestationDate)) {
    return { ok: false, status: 'Not started', reason: 'no attestation on record' };
  }
  var due = addYears(v.LastAttestationDate, 1);
  if (due < onDate) return { ok: false, status: 'Expired', reason: 'lapsed ' + due };
  return { ok: true, status: 'Complete' };
}

function backgroundStatus(row, onDate, intervalMonths) {
  var base = manualStatus(row);
  if (!base.ok) return base;
  if (row.Detail === 'Not cleared') return { ok: false, status: 'Complete', reason: 'not cleared' };
  if (intervalMonths) {
    if (!isIsoDate(row.CompletedDate)) {
      return { ok: false, status: 'Expired', reason: 'no determination date on record' };
    }
    var due = addMonths(row.CompletedDate, intervalMonths);
    if (due < onDate) return { ok: false, status: 'Expired', reason: 'recheck was due ' + due };
  }
  return base;
}

function manualStatus(row) {
  if (!row) return { ok: false, status: 'Not started', reason: 'missing' };
  if (row.Status === 'Complete') return { ok: true, status: 'Complete' };
  return { ok: false, status: row.Status || 'Not started' };
}
