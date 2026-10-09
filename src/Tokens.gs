/**
 * Personal links for volunteers (spec §4). A link carries a long random
 * token; only its SHA-256 hash is stored (Volunteers.AccessToken), so the
 * spreadsheet alone can't be used to open anyone's portal. Issuing a new link
 * replaces the old one; revoking stops it working.
 */

function bytesToHex(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) out += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  return out;
}

function newToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}

function hashToken_(token) {
  return bytesToHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(token), Utilities.Charset.UTF_8));
}

function isTokenShaped(token) {
  return /^[a-f0-9]{64}$/.test(String(token || ''));
}

/** The volunteer a link belongs to, or null. Departed volunteers' links stop working. */
function volunteerByToken_(token) {
  if (!isTokenShaped(token)) return null;
  var hash = hashToken_(token);
  var v = readRows_(TABS.VOLUNTEERS).filter(function (r) { return r.AccessToken === hash; })[0];
  if (!v || v.TokenRevokedAt || v.Status === 'Departed') return null;
  return v;
}

/** Issues a fresh link, replacing any earlier one. Call inside withLock_. */
function issueToken_(v, actor) {
  var token = newToken_();
  updateRow_(TABS.VOLUNTEERS, v._row, {
    AccessToken: hashToken_(token), TokenIssuedAt: new Date(), TokenRevokedAt: '',
    UpdatedAt: new Date(), UpdatedBy: actor.email
  });
  logAudit_(actor, 'token.issue', 'Volunteer', v.VolunteerID, v.TokenIssuedAt ? 'Replaced earlier link' : 'First link');
  return token;
}

function revokeToken_(v, actor) {
  updateRow_(TABS.VOLUNTEERS, v._row, { TokenRevokedAt: new Date(), UpdatedAt: new Date(), UpdatedBy: actor.email });
  logAudit_(actor, 'token.revoke', 'Volunteer', v.VolunteerID, '');
}

/** URLs written into src/Generated.gs by the deploy job; blank when running elsewhere. */
function deployedUrls_() {
  return typeof generatedConfig_ === 'function' ? generatedConfig_() : {};
}

function portalUrl_(param, token) {
  var base = deployedUrls_().volunteerUrl;
  if (!base) throw new Error('The volunteer portal isn\'t deployed yet (VOLUNTEER_DEPLOYMENT_ID). See README → Automatic deploys.');
  return base + '?' + param + '=' + token;
}
