// Loads the app into a context backed by the fake Apps Script services.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fakeGas } from './fake-gas.mjs';

const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');

export function boot(opts = {}) {
  const gas = fakeGas(opts);
  const globals = Object.assign({ console }, gas.globals);
  if (opts.urls !== false) {
    globals.generatedConfig_ = () => ({
      adminUrl: 'https://script.google.com/macros/s/ADMIN/exec',
      volunteerUrl: 'https://script.google.com/macros/s/PORTAL/exec'
    });
  }
  const ctx = vm.createContext(globals);
  for (const f of fs.readdirSync(src).filter((f) => f.endsWith('.gs')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(src, f), 'utf8'), ctx, { filename: f });
  }
  return { gas, app: ctx };
}

/** Plain copy, so arrays/objects from the vm compare with assert.deepEqual. */
export const plain = (x) => JSON.parse(JSON.stringify(x));
