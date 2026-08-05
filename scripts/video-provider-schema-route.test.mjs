import assert from 'node:assert/strict';
import fs from 'node:fs';

const databaseSource = fs.readFileSync('lib/db.ts', 'utf8');
const collectionRoute = fs.readFileSync('app/api/providers/video/route.ts', 'utf8');
const itemRoute = fs.readFileSync('app/api/providers/video/[id]/route.ts', 'utf8');

assert.doesNotMatch(
  databaseSource,
  /CREATE TABLE video_providers_new/,
  '普通数据库启动不得再无备份地重建供应商表',
);
for (const route of [collectionRoute, itemRoute]) {
  assert.match(route, /getVideoProviderGatewayReadiness/);
  assert.match(route, /openai-video/);
  assert.match(route, /video_provider_schema_unavailable/);
  assert.match(route, /status:\s*503/);
}

console.log('video provider schema route contract tests passed');
