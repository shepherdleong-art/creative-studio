import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDevApiRoutes, missingDevApiRoutes, sourceApiRoutes } from './runtime/dev-route-readiness.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-route-readiness-'));
const app = path.join(root, 'app');
const declaration = path.join(root, '.next/dev/types/routes.d.ts');
const sources = [
  'api/team/health/ready/route.ts',
  'api/projects/[id]/final-edit/shot-sets/[shotSetId]/external-assets/route.ts',
  'api/batch-production/batches/[id]/outputs/[planId]/arrangement/route.ts',
];
const routes = sources.map(file => '/' + file.slice(0, -'/route.ts'.length));
const publish = values => fs.writeFileSync(declaration, `type AppRouteHandlerRoutes = ${values.map(value => JSON.stringify(value)).join(' | ')};`);
const markers = () => fs.readdirSync(app).filter(file => file.startsWith('.local-preview-route-scan-'));
try {
  for (const file of sources) {
    fs.mkdirSync(path.dirname(path.join(app, file)), { recursive: true });
    fs.writeFileSync(path.join(app, file), '// fixture route\n');
  }
  fs.mkdirSync(path.dirname(declaration), { recursive: true });
  assert.deepEqual(sourceApiRoutes(root).sort(), [...routes].sort());
  assert.equal(missingDevApiRoutes(root).length, 3, 'a missing manifest is not ready');

  publish(routes.slice(0, 1));
  assert.equal(missingDevApiRoutes(root).length, 2, 'partial startup scans are not ready');
  // Simulate the watcher publishing its completed scan after an app event.
  const watcher = fs.watch(app, (_event, filename) => {
    if (filename?.startsWith('.local-preview-route-scan-')) publish(routes);
  });
  try {
    const result = await ensureDevApiRoutes(root, { timeoutMs: 3000, intervalMs: 25 });
    assert.deepEqual(result, { count: 3, recovered: true });
  } finally { watcher.close(); }
  assert.deepEqual(markers(), [], 'recovery removes its temporary marker');
  const ready = await ensureDevApiRoutes(root);
  assert.deepEqual(ready, { count: 3, recovered: false }, 'complete scans require no filesystem nudge');

  publish(routes.slice(0, 1));
  await assert.rejects(ensureDevApiRoutes(root, { timeoutMs: 60, intervalMs: 10 }), /仍缺少 2 个接口/);
  assert.deepEqual(markers(), [], 'timeout also removes its temporary marker');
  for (const file of sources) assert.equal(fs.readFileSync(path.join(app, file), 'utf8'), '// fixture route\n');
  console.log('PASS: route readiness recovers partial scans, bounds failures and preserves source');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
