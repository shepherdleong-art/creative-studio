import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateManagedProvider } from '../lib/managed-provider-policy.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const allowlist = {
  image: ['company-image'],
  script: ['company-script'],
  video: ['company-video'],
  tts: ['doubao-seed-tts-2'],
};
const hiddenVerdict = evaluateManagedProvider({
  managed: true,
  kind: 'image',
  allowlist,
  provider: {
    id: 'historical-image',
    type: 'gateway-task-image',
    baseUrl: 'http://127.0.0.1:4000',
    apiKeyEnv: 'CREATIVE_STUDIO_GATEWAY_API_KEY',
  },
});
assert.equal(hiddenVerdict.allowed, false);
assert.equal(hiddenVerdict.allowed ? '' : hiddenVerdict.code, 'managed_provider_not_allowed');

const projectRoute = read('app/api/projects/[id]/route.ts');
const projectPolicy = projectRoute.indexOf("filterManagedProviders('image', [providerIdentity]");
assert.ok(projectPolicy > 0, 'project GET must evaluate its retained provider against the managed allowlist');
for (const marker of [
  'SELECT * FROM image_assets',
  'SELECT j.*, ia.filename',
  'SELECT * FROM providers WHERE id = ?',
]) {
  assert.ok(projectPolicy < projectRoute.indexOf(marker), `project provider policy must run before ${marker}`);
}
assert.match(projectRoute, /error: 'managed_provider_not_allowed',[\s\S]*?status: 403/);
assert.match(projectRoute, /providerId: undefined,[\s\S]*?providerTaskId: undefined,[\s\S]*?remoteImageUrl: undefined,[\s\S]*?model: undefined,[\s\S]*?providerRawResponse: undefined/);

const runRoute = read('app/api/projects/[id]/run/route.ts');
const startBlock = runRoute.slice(runRoute.indexOf("case 'start':"), runRoute.indexOf("case 'pause':"));
const resumeBlock = runRoute.slice(runRoute.indexOf("case 'resume':"), runRoute.indexOf("case 'cancel':"));
for (const [label, block, mutations] of [
  ['start', startBlock, ['uuidv4()', 'writeLog({', 'UPDATE projects SET runId', 'runQueue({']],
  ['resume', resumeBlock, ['resumeQueue(', 'writeLog({']],
]) {
  const preflight = block.indexOf('managedProjectProviderDenied(provider)');
  assert.ok(preflight >= 0, `${label} must preflight the retained project provider`);
  for (const marker of mutations) {
    assert.ok(preflight < block.indexOf(marker), `${label} provider preflight must precede ${marker}`);
  }
}
assert.match(runRoute, /error: 'managed_provider_not_allowed',[\s\S]*?status: 403/);

for (const [relativePath, table, kind] of [
  ['app/api/jobs/[id]/retry/route.ts', 'jobs', 'image'],
  ['app/api/video-jobs/[id]/retry/route.ts', 'video_jobs', 'video'],
]) {
  const source = read(relativePath);
  const managedBlock = source.slice(source.indexOf('if (isManagedDeployment())'));
  const policy = managedBlock.indexOf(`filterManagedProviders('${kind}'`);
  const mutation = managedBlock.indexOf(`UPDATE ${table} SET`);
  assert.ok(policy >= 0, `${relativePath} must enforce managed provider policy`);
  assert.ok(mutation > policy, `${relativePath} must reject before mutating ${table}`);
  assert.match(managedBlock, /managed_provider_not_allowed[\s\S]*?status: 403/);
}

for (const [relativePath, assertionName] of [
  ['app/api/jobs/[id]/resume-poll/route.ts', 'assertImageExecution'],
  ['app/api/video-jobs/[id]/resume-poll/route.ts', 'assertVideoExecution'],
]) {
  const source = read(relativePath);
  const initialGate = source.indexOf(`await ${assertionName}();`);
  const firstClaim = source.indexOf('UPDATE ', initialGate);
  const managedReturn = source.indexOf('if (managedExecution)', initialGate);
  assert.ok(initialGate >= 0 && managedReturn > initialGate && managedReturn < firstClaim,
    `${relativePath} must return managed gate failures before the first database mutation`);
  const initialCatch = source.slice(initialGate, firstClaim);
  assert.match(initialCatch, /policyDenied[\s\S]*?status: policyDenied \? 403 : 423/);
}

const page = read('app/projects/[id]/page.tsx');
const gallery = read('components/ResultGallery.tsx');
const shots = read('components/ShotSetPanel.tsx');
assert.match(page, /projectProviderBlocked/);
assert.match(page, /历史供应商不可用/);
assert.match(page, /不会自动改用其他供应商/);
for (const [label, source] of [['project page', page], ['result gallery', gallery], ['shot set', shots]]) {
  assert.doesNotMatch(source, /selectableProviders\[0\]\?\.id/, `${label} must not auto-select the first provider`);
}
assert.match(gallery, /请选择公司供应商/);
assert.match(gallery, /!selectedProviderId/);
assert.match(shots, /请选择公司供应商/);
assert.match(shots, /!selectedRedoProviderId/);

console.log('legacy project provider lock tests passed');
