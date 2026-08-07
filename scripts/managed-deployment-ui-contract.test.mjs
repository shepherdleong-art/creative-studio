import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const provider = read('components/managed-deployment/ManagedDeploymentProvider.tsx');
const notice = read('components/managed-deployment/ManagedDeploymentNotice.tsx');
const managedSettings = read('components/managed-deployment/ManagedProviderSettings.tsx');
const header = read('components/Header.tsx');
const layout = read('app/layout.tsx');
const home = read('app/page.tsx');
const settings = read('app/settings/page.tsx');
const newProject = read('app/projects/new/page.tsx');
const project = read('app/projects/[id]/page.tsx');
const provisioning = read('components/provisioning/ProvisioningImportCard.tsx');

assert.match(provider, /managed-deployment\/status/);
assert.match(provider, /refreshNow/);
assert.match(provider, /setInterval|setTimeout/);
assert.match(provider, /starting|failed/);
assert.match(provider, /MANAGED_PHASES/);
assert.match(provider, /candidate\.configured/);
assert.match(provider, /candidate\.proxyAvailable/);
assert.match(notice, /settings#provisioning/);
assert.match(layout, /ManagedDeploymentProvider/);
assert.ok(layout.indexOf('<ManagedDeploymentProvider>') < layout.indexOf('<Header'), 'header must render inside the managed deployment provider');
assert.match(header, /useManagedDeployment/);
assert.match(header, /aria-disabled=[']true[']/);
assert.match(home, /useManagedDeployment|ManagedDeploymentNotice/);
assert.match(home, /settings#provisioning/);
assert.match(newProject, /ManagedDeploymentNotice/);
assert.match(project, /ManagedDeploymentNotice/);
assert.match(settings, /ManagedProviderSettings/);
assert.match(settings, /UnrestrictedSettingsPage/);
assert.match(managedSettings, /ProvisioningImportCard/);
assert.match(managedSettings, /受管供应商|allowlist|managedProviders/);
assert.match(managedSettings, /LiteLLM|代理/);
for (const endpoint of ['/api/providers', '/api/providers/script', '/api/providers/video?all=1', '/api/providers/tts']) {
  assert.ok(managedSettings.includes(endpoint), `missing managed read-only endpoint: ${endpoint}`);
}
assert.match(managedSettings, /status\?\.configured/);
assert.match(managedSettings, /status\?\.importedAt/);
assert.match(managedSettings, /setProviders\(\{\}\)/);
assert.match(managedSettings, /company-provider\/start/);
assert.match(provisioning, /refreshNow|onImported/);

assert.match(newProject, /deployment\.locked/);
assert.match(project, /deployment\.locked/);

console.log('managed deployment UI contract passed');
