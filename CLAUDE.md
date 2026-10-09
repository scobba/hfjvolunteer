# hfjvolunteer

HFJ volunteer credentialing & scheduling. Google Apps Script (V8) bound to a
Google Sheet; deployed with clasp from `src/`. No PHI in this system.

- `src/*.gs` share one global scope (Apps Script). Use `var`/function
  declarations at top level; private server functions end in `_`;
  functions the page calls are `api_*` in `Api.gs` and must call `requireAdmin_()`.
- Pure logic (no Apps Script services) lives in `Dates`, `Config`, `Matrix`,
  `Eligibility`, `Dashboard`, `Reminders` and the parse half of `Migration`.
  Keep it that way so it stays testable.
- Dates in logic are `'yyyy-MM-dd'` strings; `Db.gs` converts at the sheet boundary.
- Every write: inside `withLock_`, and logged with `logAudit_`.
- Tests: `npm test` (Node 20+, no dependencies). `test/fake-gas.mjs` is an
  in-memory stand-in for SpreadsheetApp etc. for end-to-end flows.
