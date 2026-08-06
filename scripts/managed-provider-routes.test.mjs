import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  filterManagedProviders,
  managedProviderReadOnlyBody,
  managedProviderMutationResponse,
} from '../lib/managed-provider-policy.ts';

const managedEnv = { NODE_ENV: 'test', CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' };
const unrestrictedEnv = { NODE_ENV: 'test' };
const allowlist = {
  image: ['company-image'],
  script: ['company-script'],
  video: ['company-video'],
  tts: ['doubao-seed-tts-2'],
};

const fixtures = {
  image: { id: 'company-image', type: 'gateway-task-image', baseUrl: 'http://127.0.0.1:4000/v1', apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY' },
  script: { id: 'company-script', type: 'openai-compatible', apiStyle: 'openai-compatible', executionScope: 'company', baseUrl: 'http://127.0.0.1:4000/v1' },
  video: { id: 'company-video', type: 'openai-video', baseUrl: 'http://127.0.0.1:4000/v1', apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY' },
  tts: { id: 'doubao-seed-tts-2', type: 'doubao-http-chunked', baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', keyEnv: 'DOUBAO_TTS_API_KEY' },
};

const routeFiles = {
  imageCollection: 'app/api/providers/route.ts',
  imageItem: 'app/api/providers/[id]/route.ts',
  imageActivate: 'app/api/providers/[id]/activate-only/route.ts',
  scriptCollection: 'app/api/providers/script/route.ts',
  scriptItem: 'app/api/providers/script/[id]/route.ts',
  videoCollection: 'app/api/providers/video/route.ts',
  videoItem: 'app/api/providers/video/[id]/route.ts',
  ttsCollection: 'app/api/providers/tts/route.ts',
  ttsItem: 'app/api/providers/tts/[id]/route.ts',
};
const source = Object.fromEntries(Object.entries(routeFiles).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')]));

test('unrestricted rows are preserved while managed collections filter every role', () => {
  for (const kind of ['image', 'script', 'video', 'tts']) {
    const rows = [fixtures[kind], { ...fixtures[kind], id: 'hidden-' + kind }];
    assert.equal(filterManagedProviders(kind, rows, null, { env: unrestrictedEnv }), rows);
    assert.deepEqual(filterManagedProviders(kind, rows, allowlist, { env: managedEnv }), [fixtures[kind]]);
  }
});

test('collections filter raw rows before projections or adapters', () => {
  for (const name of ['imageCollection', 'videoCollection', 'ttsCollection']) {
    assert.match(source[name], /loadManagedProviderAllowlist/);
    assert.match(source[name], /filterManagedProviders/);
  }
  assert.match(source.scriptCollection, /listScriptProviderMeta/);
  assert.ok(source.videoCollection.indexOf('filterManagedProviders') < source.videoCollection.indexOf('safeVideoProvider'));
  assert.ok(source.ttsCollection.indexOf('filterManagedProviders') < source.ttsCollection.indexOf('getFinalEditTtsAdapter(String'));
});

test('image item policy runs before safe projection and hidden rows map to 404', () => {
  const text = source.imageItem;
  assert.match(text, /loadManagedProviderAllowlist/);
  assert.match(text, /filterManagedProviders/);
  assert.ok(text.indexOf('filterManagedProviders') < text.indexOf('apiKey: undefined'));
  assert.match(text, /status:\s*404/);
});

test('all provider mutations guard before params, body readers, database, readiness, or adapters', () => {
  const mutationRoutes = [
    ['imageCollection', ['POST']], ['imageItem', ['PUT', 'DELETE']], ['imageActivate', ['POST']],
    ['scriptCollection', ['POST']], ['scriptItem', ['PUT', 'DELETE']], ['videoCollection', ['POST']],
    ['videoItem', ['PUT', 'DELETE']], ['ttsItem', ['PUT']],
  ];
  for (const [name, methods] of mutationRoutes) {
    const text = source[name];
    assert.match(text, /managedProviderMutationResponse/);
    assert.match(text, /status:\s*403/);
    for (const method of methods) {
      const start = text.indexOf('export async function ' + method);
      assert.notEqual(start, -1, name + ' must export ' + method);
      const body = text.slice(start);
      const guard = body.indexOf('managedProviderMutationResponse');
      assert.ok(guard >= 0, name + '.' + method + ' must check managed mode');
      for (const sideEffect of ['request.json()', 'getDb()', 'await params', 'getVideoProviderGatewayReadiness', 'getFinalEditTtsAdapter']) {
        const sideEffectIndex = body.indexOf(sideEffect);
        if (sideEffectIndex >= 0) assert.ok(guard < sideEffectIndex, name + '.' + method + ' guard must precede ' + sideEffect);
      }
    }
  }
});

test('managed mutation response has the exact body, and its lazy guard causes no side effects', () => {
  const expectedError = String.fromCodePoint(0x53d7, 0x7ba1, 0x5b89, 0x88c5, 0x7248, 0x53ea, 0x80fd, 0x901a, 0x8fc7, 0x7edf, 0x4e00, 0x914d, 0x7f6e, 0x5bfc, 0x5165, 0x66f4, 0x65b0, 0x4f9b, 0x5e94, 0x5546);
  assert.deepEqual(managedProviderReadOnlyBody(), { error: expectedError, code: 'managed_provider_read_only' });
  assert.deepEqual(managedProviderMutationResponse(managedEnv), { error: expectedError, code: 'managed_provider_read_only' });
  assert.equal(managedProviderMutationResponse(unrestrictedEnv), null);
  let reads = 0;
  let writes = 0;
  function runMutation(env) {
    const denied = managedProviderMutationResponse(env);
    if (denied) return { status: 403, body: denied };
    reads += 1;
    writes += 1;
    return { status: 200 };
  }
  assert.equal(runMutation(managedEnv).status, 403);
  assert.equal(reads, 0);
  assert.equal(writes, 0);
  assert.equal(runMutation(unrestrictedEnv).status, 200);
  assert.equal(reads, 1);
  assert.equal(writes, 1);
});

test('script store contains internal policy checks for rows, defaults, and stored resolution', () => {
  const text = fs.readFileSync('lib/script-providers/store.ts', 'utf8');
  assert.match(text, /filterManagedProviders/);
  assert.match(text, /loadManagedProviderAllowlist/);
  assert.match(text, /managedScriptProviderRow/);
  assert.match(text, /resolveStoredScriptProvider/);
  assert.match(text, /getScriptProviderDefaults/);
  assert.deepEqual(filterManagedProviders('script', [fixtures.script, { ...fixtures.script, id: 'hidden-script' }], null, { env: managedEnv }), []);
  assert.deepEqual(filterManagedProviders('script', [fixtures.script, { ...fixtures.script, id: 'hidden-script' }], allowlist, { env: managedEnv }), [fixtures.script]);
});

test('script store runtime filters allowlisted, hidden, and unconfigured rows before resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-script-store-'));
  const loaderPath = path.join(root, 'loader.mjs');
  fs.writeFileSync(loaderPath, [
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const root = process.env.CS_REPO_ROOT;',
    'export async function resolve(specifier, context, nextResolve) {',
    '  if (specifier.startsWith(\"@/\")) return nextResolve(pathToFileURL(path.join(root, specifier.slice(2) + \".ts\")).href, context);',
    '  if (specifier.startsWith(\".\") && !path.extname(specifier)) {',
    '    try { return await nextResolve(new URL(specifier + \".ts\", context.parentURL).href, context); } catch {}',
    '  }',
    '  return nextResolve(specifier, context);',
    '}',
  ].join(String.fromCharCode(10)), 'utf8');
  const storeUrl = pathToFileURL(path.join(process.cwd(), 'lib/script-providers/store.ts')).href;
  const dbUrl = pathToFileURL(path.join(process.cwd(), 'lib/db.ts')).href;
  const childCode = `
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '${dbUrl}';
import { getScriptProviderDefaults, getScriptProviderRows, resolveStoredScriptProvider } from '${storeUrl}';
const root = process.env.CREATIVE_STUDIO_DATA_ROOT;
const provisioning = path.join(root, 'data', 'provisioning');
fs.mkdirSync(provisioning, { recursive: true });
const config = 'gateway: test\\n';
fs.writeFileSync(path.join(root, 'config.yaml'), config);
fs.writeFileSync(path.join(provisioning, 'runtime.env'), [
  'CREATIVE_STUDIO_GATEWAY_API_KEY=\"gateway-secret\"',
  'COMPANY_GATEWAY_API_KEY=\"gateway-secret\"',
  'GATEWAY_API_KEY=\"gateway-secret\"',
  'CREATIVE_STUDIO_COS_SECRET_ID=\"id\"',
  'CREATIVE_STUDIO_COS_SECRET_KEY=\"key\"',
  'CREATIVE_STUDIO_COS_DOMAIN=\"bucket.cos.example\"',
  '',
].join('\\n'));
const state = {
  schemaVersion: 2,
  profileName: 'company',
  importedAt: '2026-08-06T00:00:00.000Z',
  configHash: crypto.createHash('sha256').update(config).digest('hex'),
  managedProviders: { image: ['company-image'], script: ['company-script'], video: ['company-video'], tts: ['doubao-seed-tts-2'] },
};
fs.writeFileSync(path.join(provisioning, 'state.json'), JSON.stringify(state));
const db = getDb();
const insert = db.prepare('INSERT INTO script_providers (id,name,type,apiStyle,baseUrl,apiKey,model,keyEnv,baseUrlEnv,modelEnv,defaultBaseUrl,defaultModel,maxTokens,enabled,isBuiltin,supportsVision,visionCostPerRequest,executionScope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
insert.run('company-script', 'Company', 'openai-compatible', 'openai-compatible', 'http://127.0.0.1:4000/v1', '', 'model', 'CREATIVE_STUDIO_GATEWAY_API_KEY', '', '', 'http://127.0.0.1:4000/v1', 'model', 1024, 1, 0, 0, 0, 'company');
insert.run('hidden-script', 'Hidden', 'openai-compatible', 'openai-compatible', 'https://external.example/v1', '', 'model', '', '', '', 'https://external.example/v1', 'model', 1024, 1, 0, 0, 0, 'external');
const allowed = getScriptProviderRows().map((row) => row.id);
let hiddenMessage = '';
try { resolveStoredScriptProvider('hidden-script'); } catch (error) { hiddenMessage = String(error.message); }
let unknownMessage = '';
try { resolveStoredScriptProvider('unknown-script'); } catch (error) { unknownMessage = String(error.message); }
const defaultId = getScriptProviderDefaults('company-script').id;
fs.unlinkSync(path.join(provisioning, 'state.json'));
const unconfigured = getScriptProviderRows().length;
delete process.env.CREATIVE_STUDIO_MANAGED_DEPLOYMENT;
const unrestricted = getScriptProviderRows().map((row) => row.id);
console.log(JSON.stringify({ allowed, hiddenMessage, unknownMessage, defaultId, unconfigured, unrestricted }));
`;
  const result = spawnSync(process.execPath, [
    '--experimental-loader=' + pathToFileURL(loaderPath).href,
    '--input-type=module', '-e', childCode,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, CS_REPO_ROOT: process.cwd(), CREATIVE_STUDIO_DATA_ROOT: root, CREATIVE_STUDIO_MANAGED_DEPLOYMENT: '1' },
    encoding: 'utf8',
  });
  try {
    assert.equal(result.status, 0, result.error ? String(result.error) : result.stderr);
    const output = JSON.parse(result.stdout.trim().split(/\\r?\\n/).pop());
    assert.deepEqual(output.allowed, ['company-script']);
    assert.equal(output.defaultId, 'company-script');
    assert.equal(output.unconfigured, 0);
    assert.match(output.hiddenMessage, /hidden-script/);
    assert.equal(output.hiddenMessage.replace('hidden-script', '<id>'), output.unknownMessage.replace('unknown-script', '<id>'));
    assert.ok(output.unrestricted.includes('company-script'));
    assert.ok(output.unrestricted.includes('hidden-script'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
