import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-auth-'));
const dbPath = path.join(fixtureRoot, 'workbench.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const { TEAM_SERVICE_MIGRATIONS } = await import('../lib/team-service/schema.ts');
for (const migration of TEAM_SERVICE_MIGRATIONS) db.exec(migration.sql);

const { BoundedKdfScheduler, createTeamAuthService } = await import('../lib/team-service/auth/service.ts');
const { initializeFirstAdministrator } = await import('../lib/team-service/auth/local-admin.ts');
const { assertIdentityOperationAllowed, createInternalTaskPrincipal } = await import('../lib/team-service/auth/types.ts');

let clock = new Date('2026-11-02T08:00:00.000Z');
const now = () => new Date(clock);
const kdf = new BoundedKdfScheduler({ maxConcurrent: 2, maxQueue: 16 });
const service = createTeamAuthService({
  db,
  now,
  kdf,
  passwordParams: { N: 1024, r: 8, p: 1 },
  loginRateLimit: { maxFailures: 5, windowMs: 15 * 60_000 },
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
  });
}

async function login(employeeId: string, password: string) {
  return service.login({ employeeId, password });
}

try {
  const initialized = await initializeFirstAdministrator({
    db,
    employeeId: '00001',
    displayName: '首管理员',
    now,
    kdf,
    passwordParams: { N: 1024, r: 8, p: 1 },
  });
  assert.match(initialized.credential, /^\d{6}$/, '首次管理员使用 6 位一次性凭据');
  await expectCode(initializeFirstAdministrator({
    db,
    employeeId: '00002',
    displayName: '重复认领',
    now,
    kdf,
    passwordParams: { N: 1024, r: 8, p: 1 },
  }), 'admin_already_initialized');

  const adminLogin = await login('00001', initialized.credential);
  assert.equal(adminLogin.principal.mustChangePassword, true);
  assert.throws(() => assertIdentityOperationAllowed(adminLogin.principal, 'business'), /改密/);
  assertIdentityOperationAllowed(adminLogin.principal, 'session');
  assertIdentityOperationAllowed(adminLogin.principal, 'change-password');
  assertIdentityOperationAllowed(adminLogin.principal, 'logout');
  const admin = await service.changeOwnPassword(
    adminLogin.principal,
    '',
    'admin-new-password-001',
  );
  assert.equal(admin.mustChangePassword, false);
  const adminSession = await login('00001', 'admin-new-password-001');
  const activeAdmin = adminSession.principal;
  await expectCode(login('00001', initialized.credential), 'invalid_credentials');

  const employeeCredential = await service.createUser(activeAdmin, {
    employeeId: '00123',
    displayName: '员工甲',
    role: 'employee',
  });
  const secondEmployeeCredential = await service.createUser(activeAdmin, {
    employeeId: '00124',
    displayName: '员工乙',
    role: 'employee',
  });
  assert.equal(employeeCredential.user.employeeId, '00123');
  const employeePasswordRow = db.prepare('SELECT employeeId, passwordHash FROM team_users WHERE id = ?').get(employeeCredential.user.id) as { employeeId: string; passwordHash: string };
  assert.equal(employeePasswordRow.employeeId, '00123');
  assert.match(employeePasswordRow.passwordHash, /^scrypt\$N=1024,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM team_users').get() as { count: number }).count, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('team_users') WHERE name LIKE '%pause%' OR name LIKE '%fee%' OR name LIKE '%concurr%'").get() as { count: number }).count, 0, '账号状态不得混入 ticket 06 的付费字段');

  const employeeLogin = await login('00123', employeeCredential.credential);
  assert.equal(employeeLogin.principal.employeeId, '00123');
  assert.equal(employeeLogin.principal.role, 'employee');
  assert.equal(employeeLogin.token.length, 43, '32 字节不透明 token 的 base64url 长度');
  // 一次性凭据只能消费一次；重复登录必须失败，但已建立的改密会话仍然有效。
  await expectCode(login('00123', employeeCredential.credential), 'credential_consumed');
  const consumedRow = db.prepare('SELECT credentialConsumedAt FROM team_users WHERE id = ?')
    .get(employeeCredential.user.id) as { credentialConsumedAt: string | null };
  assert.ok(consumedRow.credentialConsumedAt, '凭据消费时间已持久化');
  assert.equal(service.resolveSession(employeeLogin.token)?.userId, employeeCredential.user.id, '消费不撤销本次会话');
  const storedSession = db.prepare('SELECT tokenHash, absoluteExpiresAt FROM team_sessions WHERE id = ?').get(employeeLogin.principal.sessionId) as { tokenHash: string; absoluteExpiresAt: string };
  assert.match(storedSession.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(storedSession.tokenHash, employeeLogin.token);
  assert.equal(storedSession.absoluteExpiresAt, '2026-12-02T08:00:00.000Z');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM team_users').all()).includes(employeeCredential.credential), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM team_sessions').all()).includes(employeeLogin.token), false);

  clock = new Date('2026-12-01T08:00:00.000Z');
  const nearExpiry = service.resolveSession(employeeLogin.token);
  assert.equal(nearExpiry?.absoluteExpiresAt, '2026-12-02T08:00:00.000Z', '会话不滑动续期');
  clock = new Date('2026-12-02T08:00:00.000Z');
  assert.equal(service.resolveSession(employeeLogin.token), null, '到期边界立即失效');
  await expectCode(service.changeOwnPassword(employeeLogin.principal, '', 'expired-session-password'), 'session_invalid');
  clock = new Date('2026-11-02T08:00:00.000Z');

  await expectCode(service.createUser(employeeLogin.principal, {
    employeeId: '00999', displayName: '越权', role: 'employee',
  }), 'password_change_required');

  const employee = await service.changeOwnPassword(
    employeeLogin.principal,
    '',
    'employee-new-password-123',
  );
  assert.equal(service.resolveSession(employeeLogin.token), null, '改密后原会话必须重新认证');
  const relogin = await login('00123', 'employee-new-password-123');
  await expectCode(service.createUser(relogin.principal, {
    employeeId: '00999', displayName: '越权', role: 'employee',
  }), 'admin_required');
  await expectCode(login('00123', employeeCredential.credential), 'invalid_credentials');
  await expectCode(service.changeOwnPassword(relogin.principal, 'wrong-current-password', 'another-new-password-123'), 'invalid_credentials');

  await expectCode(service.changeOwnPassword({ ...relogin.principal, mustChangePassword: true }, '', 'another-new-password-123'), 'invalid_credentials');
  await expectCode(service.changeOwnPassword(employeeLogin.principal, '', 'another-new-password-123'), 'session_invalid');

  assert.ok(relogin.principal.sessionId);
  await service.setUserRole(activeAdmin, employee.userId, 'admin');
  assert.equal(service.resolveSession(relogin.token)?.role, 'admin', '角色每请求联查，而不是封进 cookie');
  await service.setUserRole(activeAdmin, employee.userId, 'employee');
  assert.equal(service.resolveSession(relogin.token)?.role, 'employee');

  const reset = await service.resetUserCredential(activeAdmin, employee.userId);
  assert.equal(service.resolveSession(employeeLogin.token), null, '重置立即撤销旧会话');
  await expectCode(login('00123', 'employee-new-password-123'), 'invalid_credentials');
  const resetLogin = await login('00123', reset.credential);
  assert.equal(resetLogin.principal.mustChangePassword, true);
  const afterReset = await service.changeOwnPassword(resetLogin.principal, '', 'employee-after-reset-123');
  await expectCode(login('00123', reset.credential), 'invalid_credentials');

  const secondLogin = await login('00124', secondEmployeeCredential.credential);
  const secondEmployee = await service.changeOwnPassword(secondLogin.principal, secondEmployeeCredential.credential, 'employee-two-new-password');
  const internal = createInternalTaskPrincipal(secondEmployee, {
    module: 'canvas', taskId: 'task-accepted-1', acceptedAt: now().toISOString(),
  });
  assert.equal(internal.kind, 'internal_task');
  assert.equal('sessionId' in internal, false);
  assert.equal(JSON.stringify(internal).includes(secondLogin.token), false);
  await service.setUserStatus(activeAdmin, secondLogin.principal.userId, 'disabled');
  assert.equal(service.resolveSession(secondLogin.token), null, '停用立即撤销会话');
  await expectCode(login('00124', 'employee-two-new-password'), 'invalid_credentials');
  assert.equal(internal.actorUserId, secondLogin.principal.userId, '已受理任务主体不依赖请求 cookie');
  await service.setUserStatus(activeAdmin, secondLogin.principal.userId, 'active');
  await login('00124', 'employee-two-new-password');

  const expiringCredential = await service.createUser(activeAdmin, {
    employeeId: '00125', displayName: '过期凭据', role: 'employee',
  });
  clock = new Date('2026-11-03T08:00:00.001Z');
  await expectCode(login('00125', expiringCredential.credential), 'invalid_credentials');
  clock = new Date('2026-11-02T08:00:00.000Z');

  const limitedCredential = await service.createUser(activeAdmin, {
    employeeId: '00126', displayName: '限流员工', role: 'employee',
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await expectCode(login('00126', `wrong-${attempt}`), 'invalid_credentials');
  }
  await expectCode(login('00126', limitedCredential.credential), 'login_rate_limited');

  const passwordChangeCredential = await service.createUser(activeAdmin, {
    employeeId: '00127', displayName: '双设备改密', role: 'employee',
  });
  const passwordChangeInitial = await login('00127', passwordChangeCredential.credential);
  await service.changeOwnPassword(passwordChangeInitial.principal, passwordChangeCredential.credential, 'before-password-change');
  const currentDevice = await login('00127', 'before-password-change');
  const otherDevice = await login('00127', 'before-password-change');
  await service.changeOwnPassword(currentDevice.principal, 'before-password-change', 'after-password-change');
  assert.equal(service.resolveSession(currentDevice.token), null, '改密后当前设备旧凭据必须失效');
  assert.equal(service.resolveSession(otherDevice.token), null, '改密后其他设备旧凭据必须撤销');
  const reauthenticated = await login('00127', 'after-password-change');
  assert.equal(reauthenticated.principal.mustChangePassword, false);

  const secondAdminCredential = await service.createUser(activeAdmin, {
    employeeId: '00002', displayName: '第二管理员', role: 'admin',
  });
  const secondAdminLogin = await login('00002', secondAdminCredential.credential);
  const secondAdmin = await service.changeOwnPassword(secondAdminLogin.principal, secondAdminCredential.credential, 'second-admin-password');
  const activeSecondAdmin = (await login('00002', 'second-admin-password')).principal;
  const removable = await service.createUser(activeAdmin, { employeeId: '00991', displayName: '待删除成员', role: 'employee' });
  const removableSession = await login('00991', removable.credential);
  await service.changeOwnPassword(removableSession.principal, '', 'removed-member-password');
  const removableActive = await login('00991', 'removed-member-password');
  assert.throws(() => service.deleteUser(removableActive.principal, employeeCredential.user.id), /管理员/);
  assert.throws(() => service.deleteUser(activeAdmin, activeAdmin.userId), /自己/);
  service.deleteUser(activeAdmin, removable.user.id);
  assert.ok(!service.listUsers(activeAdmin).some(user => user.id === removable.user.id), '删除后成员列表不再显示该账号');
  assert.equal(service.resolveSession(removableActive.token), null, '删除立即撤销已登录设备');
  await expectCode(login('00991', 'removed-member-password'), 'invalid_credentials');
  assert.ok(db.prepare('SELECT id FROM team_users WHERE id=? AND deletedAt IS NOT NULL').get(removable.user.id), '历史资源与费用仍可通过原 userId 追溯');
  assert.throws(() => service.setUserStatus(activeAdmin, removable.user.id, 'active'), /不存在/, '删除账号不能通过启用接口恢复登录');
  await service.setUserRole(activeSecondAdmin, activeAdmin.userId, 'employee');
  const freshSecondAdmin = activeSecondAdmin;
  for (const operation of [
    () => service.setUserRole(freshSecondAdmin, secondAdmin.userId, 'employee'),
    () => service.setUserStatus(freshSecondAdmin, secondAdmin.userId, 'disabled'),
    () => service.deleteUser(freshSecondAdmin, secondAdmin.userId),
  ]) {
    assert.throws(operation, (error: unknown) => Boolean(error && typeof error === 'object'
      && 'code' in error && error.code === 'last_admin_required'));
  }

  const logoutLogin = await login('00123', 'employee-after-reset-123');
  service.logout(logoutLogin.principal);
  assert.equal(service.resolveSession(logoutLogin.token), null);
  assert.equal(afterReset.role, 'employee');

  // 并发使用同一一次性凭据：恰好一次成功，另一次只得到可恢复的明确原因。
  const concurrentCredential = await service.createUser(freshSecondAdmin, {
    employeeId: '00128', displayName: '并发登录', role: 'employee',
  });
  const attempts = await Promise.allSettled([
    login('00128', concurrentCredential.credential),
    login('00128', concurrentCredential.credential),
  ]);
  assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
  const rejected = attempts.find((attempt) => attempt.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as { code?: string }).code, 'credential_consumed');

  // KDF 期间账号被重置：旧凭据登录不能成功，也不得消费新凭据。
  const gatedKdf = new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 8 });
  const racingService = createTeamAuthService({
    db, now, kdf: gatedKdf, passwordParams: { N: 1024, r: 8, p: 1 },
  });
  const racedCredential = await service.createUser(freshSecondAdmin, {
    employeeId: '00129', displayName: 'KDF 竞态', role: 'employee',
  });
  let releaseKdf: (() => void) | undefined;
  const blocker = gatedKdf.schedule(() => new Promise<void>((resolve) => { releaseKdf = resolve; }));
  const racingLogin = racingService.login({ employeeId: '00129', password: racedCredential.credential });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replaced = await service.resetUserCredential(freshSecondAdmin, racedCredential.user.id);
  releaseKdf!();
  await blocker;
  await expectCode(racingLogin, 'invalid_credentials');
  const replacedLogin = await racingService.login({ employeeId: '00129', password: replaced.credential });
  assert.equal(replacedLogin.principal.mustChangePassword, true);

  const scheduler = new BoundedKdfScheduler({ maxConcurrent: 2, maxQueue: 2 });
  let active = 0;
  let maximum = 0;
  const work = () => scheduler.schedule(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
  });
  await Promise.all([work(), work(), work(), work()]);
  assert.equal(maximum, 2);
  const blockers = [work(), work(), work(), work()];
  await expectCode(work(), 'kdf_busy');
  await Promise.all(blockers);

  console.log('team auth tests passed');
} finally {
  db.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
