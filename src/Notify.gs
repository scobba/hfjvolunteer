/**
 * Email. Admin notifications are immediate, not digested (spec §6): at HFJ's
 * size that's a handful a month, and an immediate message gets acted on.
 * Nothing sent here contains PHI.
 */

function notifyAdmins_(subject, lines) {
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var to = adminEmails_().filter(function (e) { return String(e).toLowerCase() !== me; });
  if (!to.length) return;
  var url = deployedUrls_().adminUrl;
  MailApp.sendEmail({
    to: to.join(','), name: 'HFJ Volunteers', subject: '[HFJ Volunteers] ' + subject,
    body: [].concat(lines, url ? ['', 'Dashboard: ' + url] : []).join('\n')
  });
}

function emailInvite_(v, link) {
  var first = String(v.PreferredName || v.Name || '').split(' ')[0];
  var current = v.Status === 'Active';
  var body = [
    'Hi ' + first + ',',
    '',
    current
      ? 'HFJ is moving volunteer credentialing to a new system. Please use your personal link below to confirm your details, add your license, and review and sign HFJ\'s current documents. It takes about 15 minutes, and you can come back to it at any time.'
      : 'Welcome to Healthcare for Justice! Please use your personal link below to complete onboarding: your details, your license, and HFJ\'s volunteer documents. It takes about 15 minutes, and you can come back to it at any time.',
    '',
    link,
    '',
    'This link is personal to you. Please don\'t forward it.',
    '',
    'Thank you,',
    'Healthcare for Justice'
  ].join('\n');
  MailApp.sendEmail({ to: v.Email, name: 'HFJ Volunteers', subject: 'HFJ volunteer onboarding: your personal link', body: body });
}

function emailSupervisor_(supervisorName, supervisorEmail, v, docTitle, link) {
  var body = [
    'Hello ' + supervisorName + ',',
    '',
    v.Name + ' is joining Healthcare for Justice (HFJ) as a behavioral health trainee and has named you as their supervising licensed clinician.',
    '',
    'Please review and sign the ' + docTitle + ' here:',
    link,
    '',
    'If you are not ' + v.Name + '\'s supervisor, please ignore this email or reply to let us know.',
    '',
    'Thank you,',
    'Healthcare for Justice'
  ].join('\n');
  MailApp.sendEmail({ to: supervisorEmail, name: 'HFJ Volunteers', subject: 'Please sign: ' + docTitle + ' for ' + v.Name, body: body });
}
