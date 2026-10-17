/**
 * Admin access: a signed-in account on the HFJ Workspace domain that is also
 * listed (and Active) on the Admins tab.
 */

function currentEmail_() {
  return String(Session.getActiveUser().getEmail() || '').toLowerCase();
}

function requireAdmin_() {
  var email = currentEmail_();
  if (!email) throw new Error('Sign in with your HFJ Google account to use this app.');
  var domain = String(getSettings_().AdminDomain || '').toLowerCase();
  if (domain && email.slice(-(domain.length + 1)) !== '@' + domain) {
    throw new Error(email + ' is not an @' + domain + ' account.');
  }
  var admin = readRows_(TABS.ADMINS).filter(function (a) {
    return a.Active && String(a.Email).toLowerCase() === email;
  })[0];
  if (!admin) throw new Error(email + ' is not on the Admins list.');
  return { email: email, name: admin.Name || email };
}

/**
 * For jobs that are also run by hand: the daily trigger itself, the account
 * the app runs as (in the editor), or an admin (Sheet menu). Every top-level
 * function without a trailing _ can be called from the public portal page, so
 * these must check. A trigger is recognised by its uid, checked against the
 * project's real triggers so a caller can't just claim to be one.
 */
function requireJobCaller_(e) {
  if (e && e.triggerUid) {
    var uid = String(e.triggerUid);
    if (ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === uid; })) return { email: 'system', name: 'Daily job' };
  }
  var me = currentEmail_();
  if (me && me === String(Session.getEffectiveUser().getEmail() || '').toLowerCase()) return { email: me, name: me };
  return requireAdmin_();
}

function adminEmails_() {
  return readRows_(TABS.ADMINS)
    .filter(function (a) { return a.Active && a.Email; })
    .map(function (a) { return a.Email; });
}
