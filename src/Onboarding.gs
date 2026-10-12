/**
 * The volunteer's onboarding checklist (spec §9). Pure.
 *
 * status: todo | waiting (submitted, someone else's turn) | done | hfj (only HFJ
 * can do it) | unavailable (document not published in the Documents tab yet).
 */

function onboardingTasks(v, reqRows, creds, signatures, documents, today, opts) {
  opts = opts || {};
  var tasks = [];
  var info = credentialInfo(v.Credential);
  var defs = requiredDefsFor(v) || [];
  var rowsByKey = {};
  reqRows.forEach(function (r) { rowsByKey[r.RequirementKey] = r; });
  var reqDone = function (key) { return rowsByKey[key] && rowsByKey[key].Status === 'Complete'; };

  tasks.push({
    key: 'profile', type: 'profile', title: 'Your details',
    status: v.ProfileConfirmedAt ? 'done' : 'todo'
  });

  if (info) {
    info.licenses.forEach(function (slot, i) {
      var matching = creds.filter(function (c) { return slot.indexOf(c.Type) !== -1 && !isSuperseded(c, creds); });
      var current = matching.filter(function (c) { return isIsoDate(c.ExpirationDate) && c.ExpirationDate >= today; });
      var status = 'todo', note = '';
      if (current.some(function (c) { return isVerified(c) && !needsVerification(c, v); })) status = 'done';
      else if (current.some(function (c) { return c.UploadedDocUrl || isVerified(c); })) { status = 'waiting'; note = 'HFJ is verifying this with the licensing board.'; }
      else if (matching.length && !current.length) note = 'The one on file has expired. Please add your renewed ' + (slot.length > 1 ? 'credential' : slot[0]) + '.';
      else if (matching.length) note = 'Please upload a copy (screenshot or PDF from the board website).';
      tasks.push({ key: 'license-' + i, type: 'credential', title: slot.join(' or '), credentialTypes: slot, status: status, note: note });
    });
  }

  var sigsByDoc = {};
  signatures.forEach(function (s) {
    if (s.Kind === 'void') return;
    var prev = sigsByDoc[s.DocKey];
    if (!prev || String(s.SignedAt) > String(prev.SignedAt)) sigsByDoc[s.DocKey] = s;
  });

  var outdated = {};
  outdatedDocuments(v, signatures, documents, today).forEach(function (o) { outdated[o.docKey] = o; });

  documentsFor(v).forEach(function (docKey) {
    var form = DOC_FORMS[docKey];
    var doc = documents[docKey];
    var title = doc ? doc.Title : DOC_DEFAULT_TITLES[docKey];
    var task = { key: 'doc-' + docKey, type: form.kind, docKey: docKey, title: title, status: 'todo', note: '' };
    var sig = sigsByDoc[docKey];

    if (form.attestation) {
      var due = isIsoDate(v.LastAttestationDate) ? addYears(v.LastAttestationDate, 1) : '';
      var lead = opts.attestationLeadDays || 30;
      if (due && daysBetween(today, due) > lead) { task.status = 'done'; task.note = 'Next due ' + due + '.'; }
      else if (due) task.note = 'Due ' + due + '.';
    } else {
      var reqs = form.requirements.filter(function (r) { return defs.some(function (d) { return d.key === r; }); });
      var ownDone = docKey === 'phi_policy' || docKey === 'confidentiality'
        ? sig && sig.Status === SIGNATURE_STATUS.COMPLETE
        : false;
      if (ownDone || (reqs.length && reqs.every(reqDone))) {
        task.status = 'done';
        if (!sig) task.note = 'On file with HFJ.';
      } else if (sig && sig.Status === SIGNATURE_STATUS.COMPLETE) {
        task.status = 'done';
      } else if (sig && sig.Status === SIGNATURE_STATUS.AWAITING_SUPERVISOR) {
        task.status = 'waiting'; task.note = 'Signed. Waiting for your supervisor to sign (we emailed them a link).';
      } else if (sig && sig.Status === SIGNATURE_STATUS.AWAITING_HFJ) {
        task.status = 'waiting'; task.note = 'Signed. Waiting for HFJ to countersign.';
      }
    }
    if (outdated[docKey]) {
      var o = outdated[docKey];
      task.status = 'todo'; task.outdated = true;
      task.note = 'Updated to version ' + o.version + ' (you ' + (o.kind === 'ack' ? 'acknowledged' : 'signed') +
        ' version ' + o.signedVersion + '). Please review it and ' + (o.kind === 'ack' ? 'acknowledge' : 'sign') + ' it again.';
    }
    if (task.status === 'todo' && !doc) { task.status = 'unavailable'; task.note = 'HFJ is finalizing this document.'; }
    tasks.push(task);
  });

  // Agreements HFJ hasn't written yet (the Nurse/CNA agreement).
  defs.forEach(function (d) {
    var covered = DOC_ORDER.some(function (k) { return DOC_FORMS[k].requirements.indexOf(d.key) !== -1; });
    if (d.owner === 'volunteer' && !covered && !reqDone(d.key)) {
      tasks.push({ key: 'req-' + d.key, type: 'none', title: requirementLabel(d, info.group),
        status: 'unavailable', note: 'HFJ is finalizing this document.' });
    }
  });

  defs.forEach(function (d) {
    if (d.owner !== 'admin') return;
    tasks.push({ key: 'req-' + d.key, type: 'hfj', title: requirementLabel(d, info.group),
      status: reqDone(d.key) ? 'done' : 'hfj', note: reqDone(d.key) ? '' : 'HFJ takes care of this.' });
  });

  return tasks;
}

/** True when everything the volunteer can do themselves is done or waiting on someone else. */
function volunteerPartComplete(tasks) {
  return tasks.every(function (t) { return t.status !== 'todo'; });
}
