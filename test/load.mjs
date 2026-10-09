// Loads every src/*.gs file into one shared context, the way Apps Script does.
// Only the pure modules are exercised; the rest just has to parse.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

export function loadApp() {
  const ctx = vm.createContext({ console });
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), ctx, { filename: f });
  }
  return ctx;
}

export function readSrc(name) {
  return fs.readFileSync(path.join(src, name), 'utf8');
}
