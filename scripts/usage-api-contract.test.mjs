import assert from 'node:assert/strict';
import fs from 'node:fs';

const summary = fs.readFileSync(new URL('../app/api/usage/route.ts', import.meta.url), 'utf8');
const records = fs.readFileSync(new URL('../app/api/usage/records/route.ts', import.meta.url), 'utf8');

for (const [name, source] of [['summary', summary], ['records', records]]) {
  assert.match(source, /reconcileUsageLedger\(db\)/, `${name} API must reconcile replayable evidence before reading`);
  assert.match(source, /getUsageSchemaReadiness\(db\)/, `${name} API must fail closed when usage schema is unavailable`);
  assert.match(source, /reconciliation\.reason\s*===\s*['"]schema_unavailable['"]/, `${name} API must detect schema damage after cached readiness`);
  assert.match(source, /status:\s*503/, `${name} API must return an explicit 503 without breaking other APIs`);
  assert.match(source, /parseUsageBoundary/, `${name} API must parse date boundaries as explicit instants`);
  assert.match(source, /isCoreUsageModelKey/, `${name} API must whitelist model filters`);
  assert.match(source, /isCoreUsageCategory/, `${name} API must whitelist category filters`);
  assert.match(source, /Cache-Control['"]?:\s*['"]no-store/, `${name} API must not cache local usage data`);
}

assert.match(summary, /queryUsageDashboard\(db/, 'summary API must use the tested query layer');
assert.match(records, /listUsageRecords\(db/, 'records API must use stable tested pagination');
assert.match(records, /Math\.min\(100/, 'records API must cap pageSize at 100');

console.log('usage API contract tests passed');
