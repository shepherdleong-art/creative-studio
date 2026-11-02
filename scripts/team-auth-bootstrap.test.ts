import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-auth-bootstrap-'));
const initScript = fileURLToPath(new URL('./team-server/init-admin.mjs', import.meta.url));
const recoverScript = fileURLToPath(new URL('./team-server/recover-admin.mjs', import.meta.url));
const env = {
  ...process.env,
  CREATIVE_STUDIO_DATA_ROOT: fixtureRoot,
  CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
  CREATIVE_STUDIO_PORT: '3300',
  CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-auth-bootstrap',
  CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
};

function run(script: string, employeeId: string) {
  const result = spawnSync(process.execPath, [script, '--employee-id', employeeId, '--name', '本机管理员'], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return result;
}

function credentialFrom(output: string): string {
  const matches = output.match(/[A-Za-z0-9_-]{32}/g) ?? [];
  assert.equal(matches.length, 1, `凭据只显示一次：${output}`);
  return matches[0];
}

let db: Database.Database | undefined;
try {
  const initialized = run(initScript, '00001');
  assert.equal(initialized.status, 0, initialized.stderr);
  const firstCredential = credentialFrom(initialized.stdout);
  assert.equal(initialized.stdout.includes('passwordHash'), false);

  const duplicate = run(initScript, '00003');
  assert.notEqual(duplicate.status, 0);
  assert.equal(duplicate.stdout.includes(firstCredential), false);

  db = new Database(path.join(fixtureRoot, 'data', 'workbench.db'));
  db.pragma('foreign_keys = ON');
  const { createTeamAuthService, BoundedKdfScheduler } = await import('../lib/team-service/auth/service.ts');
  const service = createTeamAuthService({
    db,
    kdf: new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 }),
    passwordParams: { N: 1024, r: 8, p: 1 },
  });
  const adminLogin = await service.login({ employeeId: '00001', password: firstCredential });
  const admin = await service.changeOwnPassword(adminLogin.principal, firstCredential, 'bootstrap-admin-password');
  const second = await service.createUser(admin, {
    employeeId: '00002', displayName: '第二管理员', role: 'admin',
  });
  const secondLogin = await service.login({ employeeId: '00002', password: second.credential });

  const recovered = run(recoverScript, '00002');
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredCredential = credentialFrom(recovered.stdout);
  assert.notEqual(recoveredCredential, second.credential);
  assert.equal(service.resolveSession(secondLogin.token), null, '本机恢复撤销目标已有会话');
  await assert.rejects(
    () => service.login({ employeeId: '00002', password: second.credential }),
    (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'invalid_credentials'),
  );
  const recoveredLogin = await service.login({ employeeId: '00002', password: recoveredCredential });
  assert.equal(recoveredLogin.principal.mustChangePassword, true);
  assert.equal(recoveredLogin.principal.role, 'admin');

  const missing = run(recoverScript, '00999');
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(missing.stdout, /[A-Za-z0-9_-]{32}/);

  console.log('team auth bootstrap tests passed');
} finally {
  db?.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
