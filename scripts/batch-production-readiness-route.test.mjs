import assert from 'node:assert/strict';
import fs from 'node:fs';

const route = fs.readFileSync('app/api/batch-production/readiness/route.ts', 'utf8');

assert.match(route, /getBatchProductionReadiness/);
assert.match(route, /await getBatchProductionReadiness\(\)/);
assert.match(route, /Cache-Control/);
assert.match(route, /no-store/);
assert.match(route, /readiness_check_failed/);
assert.match(route, /status:\s*503/);

console.log('batch production readiness route contract tests passed');
