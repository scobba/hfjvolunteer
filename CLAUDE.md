# hfjvolunteer

HFJ volunteer credentialing & scheduling. Google Apps Script (V8) bound to a
Google Sheet; deployed with clasp from `src/`. No PHI in this system.

- `src/*.gs` share one global scope (Apps Script). Use `var`/function
  declarations at top level; private server functions end in `_`;
  functions the page calls are `api_*` in `Api.gs` and must call `requireAdmin_()`.
- Pure logic (no Apps Script services) lives in `Dates`, `Config`, `Matrix`,
  `Eligibility`, `Dashboard`, `Reminders`, `Documents`, `Render`, `Uploads`,
  `Onboarding`, `parseInviteList` and the parse half of `Migration`.
  Keep it that way so it stays testable.
- Volunteer-facing calls are `portal_*` / `supervisor_*` in `Portal.gs`: they take
  the link token, resolve the volunteer server-side, and must never trust an ID
  or path from the browser. Document *text* lives in the Sheet's Documents tab
  (not this public repo); `DOC_FORMS` in `Documents.gs` defines how each behaves.
- Drive access is `drive.file` only (app-created files). Never widen it: the
  HFJ EMR lives in Google Drive.
- Dates in logic are `'yyyy-MM-dd'` strings; `Db.gs` converts at the sheet boundary.
- Every write: inside `withLock_`, and logged with `logAudit_`.
- Merging to `main` deploys (`.github/workflows/deploy.yml`): tests → `clasp push` →
  both web app deployments (admin, portal) move to the new version. Never commit credentials;
  this repo is public.
- Tests: `npm test` (Node 20+, no dependencies). `test/fake-gas.mjs` is an
  in-memory stand-in for SpreadsheetApp etc. for end-to-end flows.
