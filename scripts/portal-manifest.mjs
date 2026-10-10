// Deploy job: switches the manifest to anonymous web app access for the
// volunteer portal deployment. The admin deployment keeps domain-only access.
import fs from 'node:fs';

const p = new URL('../src/appsscript.json', import.meta.url);
const m = JSON.parse(fs.readFileSync(p, 'utf8'));
m.webapp.access = 'ANYONE_ANONYMOUS';
fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
console.log('webapp.access =', m.webapp.access);
