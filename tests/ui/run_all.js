// Runs every tests/ui/*_test.js in its own plain `node` process; exits non-zero if any fails.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('_test.js')).sort();
if (files.length === 0) { console.error('No *_test.js files found in ' + dir); process.exit(1); }

let failed = 0;
for (const f of files) {
  console.log('\n== ' + f);
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed}/${files.length} UI suites FAILED` : `\nAll ${files.length} UI suites passed`);
process.exit(failed ? 1 : 0);
