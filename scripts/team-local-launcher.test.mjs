import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveLocalTeamConfig } from '../team-desktop/launcher.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const defaults = resolveLocalTeamConfig({});
assert.equal(defaults.port, 3400);
assert.equal(defaults.origin, 'http://127.0.0.1:3400');
assert.equal(defaults.deploymentId, 'mac-local-team');
assert.equal(defaults.dataRoot, path.join(repoRoot, 'team-desktop', 'data-root'));
assert.notEqual(defaults.dataRoot, repoRoot);
assert.ok(!defaults.statePath.includes('control-credential'));

const custom = resolveLocalTeamConfig({
  CREATIVE_STUDIO_TEAM_LOCAL_PORT: '3510',
  CREATIVE_STUDIO_TEAM_LOCAL_DATA_ROOT: path.join(repoRoot, 'outputs', 'team-local-test'),
  CREATIVE_STUDIO_TEAM_LOCAL_DEPLOYMENT_ID: 'mac-test',
});
assert.equal(custom.origin, 'http://127.0.0.1:3510');
assert.equal(custom.deploymentId, 'mac-test');
assert.equal(custom.dataRoot, path.join(repoRoot, 'outputs', 'team-local-test'));

for (const env of [
  { CREATIVE_STUDIO_TEAM_LOCAL_PORT: '0' },
  { CREATIVE_STUDIO_TEAM_LOCAL_PORT: 'abc' },
  { CREATIVE_STUDIO_TEAM_LOCAL_PORT: '65536' },
  { CREATIVE_STUDIO_TEAM_LOCAL_DATA_ROOT: repoRoot },
  { CREATIVE_STUDIO_TEAM_LOCAL_DATA_ROOT: path.join(repoRoot, 'team-desktop') },
  { CREATIVE_STUDIO_TEAM_LOCAL_DEPLOYMENT_ID: '../escape' },
]) {
  assert.throws(() => resolveLocalTeamConfig(env));
}

for (const script of ['start.command', 'stop.command', 'recover-admin.command', 'node-runtime.sh']) {
  const result = spawnSync('bash', ['-n', path.join(repoRoot, 'team-desktop', script)]);
  assert.equal(result.status, 0, `${script} 的 bash 语法必须有效`);
}

const printed = spawnSync(process.execPath, [path.join(repoRoot, 'team-desktop', 'launcher.mjs'), 'print-config'], {
  cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CREATIVE_STUDIO_TEAM_LOCAL_PORT: '3510' },
});
assert.equal(printed.status, 0, printed.stderr);
const printedConfig = JSON.parse(printed.stdout);
assert.equal(printedConfig.origin, 'http://127.0.0.1:3510');
assert.ok(!('credentialPath' in printedConfig), '配置输出不得包含控制凭据路径');
assert.ok(!printed.stdout.includes('token'), '配置输出不得包含控制凭据');

const desktopSource = spawnSync(process.execPath, ['-e', `
  const fs = require('node:fs');
  const source = fs.readFileSync('desktop/client/remote-host.ts', 'utf8');
  if (!source.includes("mode === 'local-team'")) process.exit(1);
`], { cwd: repoRoot });
assert.equal(desktopSource.status, 0, '启动器必须走显式 local-team 桌面模式');

console.log('team local launcher tests passed');
