// Read-only integration check against an already running local preview.
// Run: node scripts/local-preview-routes.test.mjs [http://127.0.0.1:3410]
import assert from 'node:assert/strict';
import path from 'node:path';
import { missingDevApiRoutes, sourceApiRoutes } from './runtime/dev-route-readiness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const origin = process.argv[2] || 'http://127.0.0.1:3410';
const url = new URL(origin);
assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'only check a loopback development server');
const routes = sourceApiRoutes(root);
const missing = missingDevApiRoutes(root, routes);

// These deep routes must reach authentication, even with nonexistent fixture IDs.
// Framework HTML 404 means routing failed before the authorization boundary.
for (const route of [
  '/api/projects/route-probe/final-edit/shot-sets/route-probe/external-assets',
  '/api/batch-production/batches/route-probe/outputs/route-probe/arrangement',
  '/api/batch-production/batches/route-probe/outputs/route-probe/media',
]) {
  const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 401, `${route}: expected authentication, received HTTP ${response.status}`);
}
assert.deepEqual(missing, [], 'all source API routes must be registered in the development server');
console.log(`PASS: ${routes.length} API routes registered; deep mixcut/batch routes reach authentication`);
