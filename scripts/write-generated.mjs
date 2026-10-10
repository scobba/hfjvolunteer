// Deploy job: writes src/Generated.gs with the two web app URLs, which the
// app uses for links in emails. The file isn't committed.
import fs from 'node:fs';

const url = (id) => (id ? `https://script.google.com/macros/s/${id}/exec` : '');
const config = { adminUrl: url(process.env.ADMIN_ID), volunteerUrl: url(process.env.VOLUNTEER_ID) };
const src = `/** Written by the deploy job; not in git. */\nfunction generatedConfig_() {\n  return ${JSON.stringify(config)};\n}\n`;
fs.writeFileSync(new URL('../src/Generated.gs', import.meta.url), src);
console.log(src);
