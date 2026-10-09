/**
 * Volunteer folders and files, through the Drive API (advanced service) with
 * the drive.file scope: this app can see only the folders and files it
 * created. HFJ's other Drive content, including the HFJ EMR, is out of reach.
 *
 * Folders live under one "HFJ Volunteers" folder owned by the account the web
 * app runs as, shared with the admins.
 */

var FOLDER_MIME = 'application/vnd.google-apps.folder';

function folderUrl_(id) { return 'https://drive.google.com/drive/folders/' + id; }
function fileUrl_(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }

function rootFolderId_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('ROOT_FOLDER_ID');
  if (id) return id;
  var f = Drive.Files.create({ name: 'HFJ Volunteers', mimeType: FOLDER_MIME });
  props.setProperty('ROOT_FOLDER_ID', f.id);
  shareWithAdmins_(f.id);
  logAudit_('system', 'drive.root', 'Folder', f.id, 'Created HFJ Volunteers folder');
  return f.id;
}

/** Gives every active admin edit access to the volunteer folders. Safe to repeat. */
function shareWithAdmins_(folderId) {
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  adminEmails_().forEach(function (email) {
    if (String(email).toLowerCase() === me) return;
    try {
      Drive.Permissions.create({ role: 'writer', type: 'user', emailAddress: email }, folderId, { sendNotificationEmail: false });
    } catch (e) {
      logAudit_('system', 'drive.share.error', 'Folder', folderId, email + ': ' + e.message);
    }
  });
}

/** The volunteer's own folder, created on first need. Call inside withLock_. */
function ensureVolunteerFolder_(v) {
  if (v.FolderId) return v.FolderId;
  var f = Drive.Files.create({ name: volunteerFolderName(v), mimeType: FOLDER_MIME, parents: [rootFolderId_()] });
  v.FolderId = f.id;
  v.FolderUrl = folderUrl_(f.id);
  updateRow_(TABS.VOLUNTEERS, v._row, { FolderId: v.FolderId, FolderUrl: v.FolderUrl });
  logAudit_('system', 'drive.folder', 'Volunteer', v.VolunteerID, 'Created folder ' + volunteerFolderName(v));
  return v.FolderId;
}

/** Saves a blob into a folder this app created. Returns { id, url }. */
function saveFile_(folderId, name, blob) {
  var f = Drive.Files.create({ name: name, parents: [folderId] }, blob.setName(name));
  return { id: f.id, url: fileUrl_(f.id) };
}

function pdfFromHtml_(html, name) {
  return HtmlService.createHtmlOutput(html).getAs('application/pdf').setName(name);
}

/**
 * Decodes and checks an upload from the browser: { name, mime, base64 }.
 * Returns a blob with a trusted content type. Throws a readable error otherwise.
 */
function blobFromUpload_(file) {
  if (!file || typeof file.base64 !== 'string') throw new Error('No file received.');
  if (file.base64.length > UPLOAD_MAX_BYTES * 1.4) throw new Error('The file is larger than 5 MB. Please send a smaller copy.');
  var bytes = Utilities.base64Decode(file.base64);
  var ok = validateUpload(file.name, file.mime, bytes);
  return { blob: Utilities.newBlob(bytes, ok.mime), ext: ok.ext };
}
