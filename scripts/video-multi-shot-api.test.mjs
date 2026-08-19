import assert from 'node:assert/strict';
import fs from 'node:fs';

const singleRoute = fs.readFileSync('app/api/shot-sets/[id]/video-jobs/route.ts', 'utf8');
const batchRoute = fs.readFileSync('app/api/shot-sets/[id]/video-jobs/batch/route.ts', 'utf8');

for (const [label, route] of [['single', singleRoute], ['batch', batchRoute]]) {
  assert.match(route, /video-multi-shot/, `${label} route must use the shared multi-shot module`);
  assert.match(route, /normalizeVideoMultiShotForStorage/, `${label} route must normalize multiShot on the server`);
  assert.match(route, /getVideoProviderConfigState/, `${label} route must retain safe provider configuration validation`);
  assert.doesNotMatch(route, /resolveVideoProviderRuntimeConfig/, `${label} route must not invoke the throwing runtime resolver`);
  assert.match(route, /body\.multiShot|obj\.multiShot/, `${label} route must accept the optional multiShot input`);
  assert.match(route, /INSERT INTO video_jobs[\s\S]*multiShot/, `${label} route must persist the nullable multiShot column`);
}

assert.match(
  singleRoute,
  /const model = \(provider\.defaultModel \|\| ''\)\.trim\(\)/,
  'single route must freeze a trimmed local model value',
);
assert.match(
  batchRoute,
  /const model = \(prov\.defaultModel \|\| ''\)\.trim\(\)/,
  'batch route must cache a trimmed local model value',
);

assert.match(
  singleRoute,
  /normalizeVideoMultiShotForStorage[\s\S]*provider\.type[\s\S]*model/,
  'single route must normalize against the actual provider type and canonical model',
);
assert.match(
  batchRoute,
  /normalizeVideoMultiShotForStorage[\s\S]*p\.type[\s\S]*p\.model/,
  'batch route must normalize each row against its resolved provider type and canonical model',
);

console.log('video multi-shot API contract tests passed');
