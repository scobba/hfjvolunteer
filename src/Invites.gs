/**
 * Invitations (spec §4: intake is invite-only). An admin enters name, email
 * and credential; the volunteer gets a personal link by email.
 */

/**
 * Parses pasted lines "Name, email, credential" (commas or tabs, so a block
 * copied from a spreadsheet works). Pure.
 */
function parseInviteList(text) {
  var rows = [], errors = [], seen = {};
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (line, i) {
    if (!line.trim()) return;
    var parts = line.split(line.indexOf('\t') !== -1 ? '\t' : ',').map(function (p) { return p.trim(); });
    var emailAt = -1;
    parts.forEach(function (p, j) { if (emailAt === -1 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p)) emailAt = j; });
    var lineNo = 'Line ' + (i + 1);
    if (emailAt === -1 && /\bname\b/i.test(line) && /\bemail\b/i.test(line)) return; // header row
    if (emailAt === -1) { errors.push(lineNo + ': no email address'); return; }
    var email = parts[emailAt].toLowerCase();
    // Name first, credential last ("Do Nguyen, do@x.org, MD" must not read "Do" as DO).
    var others = parts.filter(function (_, j) { return j !== emailAt && parts[j]; });
    var name = others[0] || '';
    var credential = others.length > 1 ? parseCredential(others[others.length - 1]) : '';
    if (!name) { errors.push(lineNo + ': no name'); return; }
    if (!credential) { errors.push(lineNo + ' (' + name + '): credential not recognized'); return; }
    if (seen[email]) { errors.push(lineNo + ': ' + email + ' appears twice'); return; }
    seen[email] = true;
    rows.push({ Name: name, Email: email, Credential: credential });
  });
  return { rows: rows, errors: errors };
}

/** Issues a new link and emails it. Replaces any earlier link. */
function inviteVolunteer_(volunteerId, actor) {
  var link = withLock_(function () {
    var v = findRow_(TABS.VOLUNTEERS, 'VolunteerID', volunteerId);
    if (!v) throw new Error('No volunteer ' + volunteerId);
    if (!v.Email) throw new Error(v.Name + ' has no email address.');
    if (v.Status === 'Departed') throw new Error(v.Name + ' is marked Departed.');
    var token = issueToken_(v, actor);
    updateRow_(TABS.VOLUNTEERS, v._row, { InvitedAt: new Date() });
    return { v: v, url: portalUrl_('t', token) };
  });
  emailInvite_(link.v, link.url);
  logAudit_(actor, 'volunteer.invite', 'Volunteer', volunteerId, 'Link emailed to ' + link.v.Email);
  return link.v.Email;
}

/**
 * Creates anyone not yet on the roster (matched by email) and emails each
 * person their link. status: 'Active' for current volunteers being re-onboarded,
 * 'Prospective' for new ones.
 */
function bulkInvite_(text, status, actor) {
  if (VOLUNTEER_STATUSES.indexOf(status) === -1) throw new Error('Unknown status.');
  var parsed = parseInviteList(text);
  var result = { created: 0, invited: 0, skipped: [], errors: parsed.errors.slice() };
  if (!parsed.rows.length) return result;
  portalUrl_('t', 'x'); // fails early, before anyone is created, if the portal isn't deployed
  parsed.rows.forEach(function (r) {
    try {
      var v = findRow_(TABS.VOLUNTEERS, 'Email', r.Email);
      if (!v) {
        v = createVolunteer_({ Name: r.Name, Email: r.Email, Credential: r.Credential, Status: status }, actor);
        result.created++;
      } else if (v.InvitedAt && !v.TokenRevokedAt) {
        result.skipped.push(r.Name + ' (already invited; use Resend link on their page)');
        return;
      }
      inviteVolunteer_(v.VolunteerID, actor);
      result.invited++;
    } catch (e) {
      result.errors.push(r.Name + ': ' + e.message);
    }
  });
  return result;
}
