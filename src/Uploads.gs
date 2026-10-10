/**
 * Upload checks (spec §9, "Upload endpoint security"). Pure.
 *
 * The volunteer upload path is unauthenticated apart from the link token, so
 * a file is accepted only if its name, its declared type AND its first bytes
 * all agree that it is a PDF or a common image, and it is under the size cap.
 * Where it is saved is decided server-side from the token, never from anything
 * the browser sends.
 */

var UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

var UPLOAD_TYPES = {
  pdf: { mime: 'application/pdf', exts: ['pdf'] },
  png: { mime: 'image/png', exts: ['png'] },
  jpeg: { mime: 'image/jpeg', exts: ['jpg', 'jpeg'] },
  webp: { mime: 'image/webp', exts: ['webp'] },
  heic: { mime: 'image/heic', exts: ['heic', 'heif'] }
};

/** Recognizes a file by its first bytes. Bytes may be signed (Apps Script) or unsigned. */
function sniffFileType(bytes) {
  var b = [];
  for (var i = 0; i < Math.min(bytes.length, 16); i++) b.push(bytes[i] & 0xff);
  var ascii = function (from, to) { return String.fromCharCode.apply(null, b.slice(from, to)); };
  if (ascii(0, 4) === '%PDF') return 'pdf';
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(ascii(8, 12))) return 'heic';
  return '';
}

/** Throws a user-readable error, or returns { type, mime, ext }. */
function validateUpload(fileName, declaredMime, bytes) {
  if (!bytes || !bytes.length) throw new Error('The file is empty.');
  if (bytes.length > UPLOAD_MAX_BYTES) throw new Error('The file is larger than 5 MB. Please send a smaller copy.');
  var ext = String(fileName || '').toLowerCase().split('.').pop();
  var type = sniffFileType(bytes);
  var spec = UPLOAD_TYPES[type];
  if (!spec) throw new Error('Only PDF or image files (PNG, JPEG, HEIC, WEBP) can be uploaded.');
  if (spec.exts.indexOf(ext) === -1) throw new Error('The file name doesn\'t match its contents. Please upload the original file.');
  var declared = String(declaredMime || '').toLowerCase();
  if (declared && declared !== spec.mime && !(type === 'heic' && /^image\/hei[cf]$/.test(declared)) &&
      !(type === 'jpeg' && declared === 'image/jpg')) {
    throw new Error('The file type doesn\'t match its contents. Please upload the original file.');
  }
  return { type: type, mime: spec.mime, ext: spec.exts[0] };
}
