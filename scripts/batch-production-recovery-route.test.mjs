import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/batch-production/recovery/route.ts', 'utf8');

assert.match(route, /listSchemaUpgradeRecoveryCandidates/);
assert.match(route, /requiresApplicationShutdown:\s*true/);
assert.match(route, /automaticRestoreAvailable:\s*false/);
assert.match(route, /Cache-Control/);
assert.match(route, /no-store/);

console.log('batch production recovery route contract tests passed');
