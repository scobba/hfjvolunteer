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

function adminEmails_() {
  return readRows_(TABS.ADMINS)
    .filter(function (a) { return a.Active && a.Email; })
    .map(function (a) { return a.Email; });
}
