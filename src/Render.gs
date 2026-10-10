/**
 * Turns Documents-tab text into HTML for the portal and for signed PDFs. Pure.
 *
 * Text format (kept deliberately small, so admins can edit it in a cell):
 *   # Title          ## Section heading
 *   - bullet item    1. numbered item
 *   blank line = new paragraph; {{Key}} = a filled-in value
 */

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fillPlaceholders_(escapedLine, values) {
  return escapedLine.replace(/\{\{\s*([A-Za-z]+)\s*\}\}/g, function (_, key) {
    var v = values && values[key];
    return v ? '<span class="filled">' + escapeHtml(v) + '</span>' : '<span class="blank">&nbsp;</span>';
  });
}

function renderBodyHtml(body, values) {
  var out = [], para = [], list = null;
  function flushPara() {
    if (para.length) out.push('<p>' + para.join('<br>') + '</p>');
    para = [];
  }
  function flushList() {
    if (list) out.push('<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>');
    list = null;
  }
  String(body || '').replace(/\r\n?/g, '\n').split('\n').forEach(function (raw) {
    var line = raw.trim();
    var m;
    if (!line) { flushPara(); flushList(); return; }
    var html = function (t) { return fillPlaceholders_(escapeHtml(t), values); };
    if ((m = line.match(/^(#{1,2})\s+(.*)$/))) {
      flushPara(); flushList();
      out.push('<h' + m[1].length + '>' + html(m[2]) + '</h' + m[1].length + '>');
    } else if ((m = line.match(/^[-•]\s+(.*)$/)) || (m = line.match(/^\d+[.)]\s+(.*)$/))) {
      var tag = /^\d/.test(line) ? 'ol' : 'ul';
      flushPara();
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag: tag, items: [] };
      list.items.push('<li>' + html(m[1]) + '</li>');
    } else {
      flushList();
      para.push(html(line));
    }
  });
  flushPara(); flushList();
  return out.join('\n');
}

/**
 * Full HTML page for a signed PDF.
 * sigs: [{ role, name, title, signedAt, image (data URL), extra }]
 */
function buildSignedDocumentHtml(doc, values, sigs, recordLine) {
  var blocks = sigs.map(function (s) {
    var img = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(s.image || '')
      ? '<img class="sig" src="' + s.image + '">' : '';
    return '<div class="sigblock"><div class="role">' + escapeHtml(s.role) + '</div>' + img +
      '<div class="line"></div><div>' + escapeHtml(s.name) +
      (s.title ? ', ' + escapeHtml(s.title) : '') + '</div>' +
      '<div class="meta">Signed electronically ' + escapeHtml(s.signedAt) +
      (s.extra ? ' · ' + escapeHtml(s.extra) : '') + '</div></div>';
  }).join('');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.45;color:#111;margin:36px}' +
    'h1{font-size:16pt;margin:0 0 4px}h2{font-size:12pt;margin:16px 0 4px}' +
    '.org{color:#555;font-size:10pt;margin-bottom:14px}.version{color:#555;font-size:9pt}' +
    '.filled{font-weight:bold;border-bottom:1px solid #999}.blank{display:inline-block;min-width:160px;border-bottom:1px solid #999}' +
    '.sigs{margin-top:28px;page-break-inside:avoid}.sigblock{margin:18px 0}.role{font-weight:bold}' +
    '.sig{height:60px;display:block;margin-top:4px}.line{border-top:1px solid #333;width:280px;margin:2px 0 4px}' +
    '.meta{color:#555;font-size:9pt}.record{margin-top:24px;color:#555;font-size:8pt;border-top:1px solid #ccc;padding-top:6px}' +
    '</style></head><body>' +
    '<div class="org">Healthcare for Justice (HFJ) · <span class="version">' + escapeHtml(doc.Title) +
    ' · version ' + escapeHtml(doc.Version) + (doc.EffectiveDate ? ', effective ' + escapeHtml(doc.EffectiveDate) : '') +
    '</span></div>' + renderBodyHtml(doc.Body, values) +
    '<div class="sigs">' + blocks + '</div>' +
    '<div class="record">' + escapeHtml(recordLine) + '</div></body></html>';
}

/** Standard file name: "2026-10-09 Lee, Ann – Volunteer Provider Agreement v1.0.pdf". No PHI, just the volunteer. */
function documentFileName(date, volunteer, title, version, ext) {
  var name = String(title + (version ? ' v' + version : '')).replace(/[\\/:*?"<>|]+/g, '-');
  return date + ' ' + folderPersonName(volunteer) + ' – ' + name + '.' + (ext || 'pdf');
}

/** "Lee, Ann" from "Ann Lee"; single names are kept as they are. */
function folderPersonName(volunteer) {
  var parts = String(volunteer.Name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || volunteer.VolunteerID;
  return parts[parts.length - 1] + ', ' + parts.slice(0, -1).join(' ');
}

function volunteerFolderName(volunteer) {
  return folderPersonName(volunteer) + ' (' + volunteer.VolunteerID + ')';
}
