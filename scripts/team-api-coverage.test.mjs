import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { checkTeamApiCoverage } = await import('./team-api-coverage.mjs');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-api-coverage-'));

function route(relative, source) {
  const file = path.join(fixtureRoot, 'app', 'api', relative, 'route.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function policies(entries) {
  const file = path.join(fixtureRoot, 'policies.mjs');
  fs.writeFileSync(file, `export const TEAM_ROUTE_POLICIES = ${JSON.stringify(entries, null, 2)};\n`);
  return file;
}

async function check(entries) {
  return checkTeamApiCoverage({ repoRoot: fixtureRoot, policyUrl: pathToFileURL(policies(entries)).href });
}

const wrapped = (routeName, method) => `export const ${method} = withTeamRoute('${routeName}', '${method}', async () => new Response());\n`;

try {
  route('projects', wrapped('/api/projects', 'GET') + wrapped('/api/projects', 'POST'));
  const base = [
    { route: '/api/projects', method: 'GET', category: 'resource', resource: 'project_collection', action: 'read', csrf: false },
    { route: '/api/projects', method: 'POST', category: 'resource', resource: 'project_create', action: 'write', csrf: true },
  ];
  const initial = await check(base);
  assert.equal(initial.ok, true);
  assert.equal(initial.routeCount, 1);
  assert.equal(initial.methodCount, 2);

  fs.appendFileSync(path.join(fixtureRoot, 'app/api/projects/route.ts'), wrapped('/api/projects', 'DELETE'));
  assert.equal((await check(base)).errors.some((error) => error.code === 'unclassified' && error.key === '/api/projects DELETE'), true);
  assert.equal((await check([...base, { route: '/api/projects', method: 'DELETE', category: 'resource', resource: 'project_collection', action: 'write', csrf: true }, { route: '/api/ghost', method: 'GET', category: 'authenticated', csrf: false }])).errors.some((error) => error.code === 'stale_policy'), true);
  assert.equal((await check([...base, ...base])).errors.some((error) => error.code === 'duplicate_policy'), true);

  route('broken', 'export { GET } from "./handler";\n');
  assert.equal((await check(base)).errors.some((error) => error.code === 'unsupported_export'), true);
  fs.rmSync(path.join(fixtureRoot, 'app/api/broken'), { recursive: true });

  route('missing-wrapper', 'export async function GET() { return new Response(); }\n');
  assert.equal((await check(base)).errors.some((error) => error.code === 'missing_wrapper'), true);
  fs.rmSync(path.join(fixtureRoot, 'app/api/missing-wrapper'), { recursive: true });

  route('shutdown', wrapped('/api/shutdown', 'POST'));
  assert.equal((await check([...base, { route: '/api/shutdown', method: 'POST', category: 'authenticated', csrf: true }])).errors.some((error) => error.code === 'invalid_server_exception'), true);

  console.log('team api coverage fixture tests passed');
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

const real = await checkTeamApiCoverage({ repoRoot: path.resolve(import.meta.dirname, '..') });
assert.deepEqual(real.errors, [], real.errors.map((error) => `${error.code}: ${error.key ?? ''} ${error.message}`).join('\n'));
console.log(`team api coverage real repository passed (${real.routeCount} routes, ${real.methodCount} methods)`);
