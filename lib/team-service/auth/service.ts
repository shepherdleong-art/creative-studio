import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  BoundedKdfScheduler,
  generateOneTimeCredential,
  hashPassword,
  PRODUCTION_SCRYPT_PARAMS,
  verifyPassword,
  type ScryptParams,
} from './passwords.ts';
import {
  assertIdentityOperationAllowed,
  TeamAuthError,
  type AuthPrincipal,
  type TeamRole,
  type TeamUserStatus,
  type TeamUserView,
} from './types.ts';

export { BoundedKdfScheduler } from './passwords.ts';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const CREDENTIAL_DURATION_MS = 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  employeeId: string;
  displayName: string;
  role: TeamRole;
  status: TeamUserStatus;
  passwordHash: string;
  mustChangePassword: number;
  credentialExpiresAt: string | null;
  sessionVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionRow {
  id: string;
  userId: string;
  sessionVersion: number;
  absoluteExpiresAt: string;
}

interface LoginFailure {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export interface TeamAuthServiceOptions {
  db: Database.Database;
  now?: () => Date;
  kdf?: BoundedKdfScheduler;
  passwordParams?: ScryptParams;
  loginRateLimit?: { maxFailures: number; windowMs: number };
}

export interface LoginResult {
  principal: AuthPrincipal;
  token: string;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function userView(row: UserRow): TeamUserView {
  return {
    id: row.id,
    employeeId: row.employeeId,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    mustChangePassword: row.mustChangePassword === 1,
    credentialExpiresAt: row.credentialExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateEmployeeId(value: string): string {
  const employeeId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(employeeId)) {
    throw new TeamAuthError('invalid_employee_id', '工号格式无效。');
  }
  return employeeId;
}

function validateDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName || displayName.length > 80) {
    throw new TeamAuthError('invalid_display_name', '姓名不能为空且不能超过 80 个字符。');
  }
  return displayName;
}

function validateNewPassword(value: string): void {
  if (value.length < 12 || value.length > 128) {
    throw new TeamAuthError('invalid_password', '新密码须为 12–128 个字符。');
  }
}

export function createTeamAuthService(options: TeamAuthServiceOptions) {
  const db = options.db;
  const now = options.now ?? (() => new Date());
  const kdf = options.kdf ?? new BoundedKdfScheduler({ maxConcurrent: 1, maxQueue: 32 });
  const passwordParams = options.passwordParams ?? PRODUCTION_SCRYPT_PARAMS;
  const rateLimit = options.loginRateLimit ?? { maxFailures: 5, windowMs: 15 * 60_000 };
  const failures = new Map<string, LoginFailure>();

  function userById(id: string): UserRow | undefined {
    return db.prepare('SELECT * FROM team_users WHERE id = ?').get(id) as UserRow | undefined;
  }

  function userByEmployeeId(employeeId: string): UserRow | undefined {
    return db.prepare('SELECT * FROM team_users WHERE employeeId = ?').get(employeeId) as UserRow | undefined;
  }

  function principalFrom(row: UserRow, session: SessionRow): AuthPrincipal {
    return {
      kind: 'user',
      userId: row.id,
      employeeId: row.employeeId,
      displayName: row.displayName,
      role: row.role,
      sessionId: session.id,
      sessionVersion: row.sessionVersion,
      mustChangePassword: row.mustChangePassword === 1,
      absoluteExpiresAt: session.absoluteExpiresAt,
    };
  }

  function currentUserForSession(principal: AuthPrincipal): UserRow {
    const session = db.prepare(`
      SELECT * FROM team_sessions
      WHERE id = ? AND userId = ? AND revokedAt IS NULL AND absoluteExpiresAt > ?
    `).get(principal.sessionId, principal.userId, now().toISOString()) as SessionRow | undefined;
    const user = userById(principal.userId);
    if (!session || !user || user.status !== 'active'
      || session.sessionVersion !== user.sessionVersion
      || principal.sessionVersion !== user.sessionVersion) {
      throw new TeamAuthError('session_invalid', '登录状态已失效，请重新登录。', 401);
    }
    return user;
  }

  function requireAdmin(principal: AuthPrincipal): UserRow {
    assertIdentityOperationAllowed(principal, 'users');
    const user = currentUserForSession(principal);
    if (user.role !== 'admin') throw new TeamAuthError('admin_required', '需要管理员权限。', 403);
    return user;
  }

  function checkRateLimit(employeeId: string): void {
    const timestamp = now().getTime();
    const failure = failures.get(employeeId);
    if (!failure) return;
    if (failure.blockedUntil > timestamp) {
      throw new TeamAuthError('login_rate_limited', '登录尝试过多，请稍后重试。', 429);
    }
    if (timestamp - failure.windowStartedAt >= rateLimit.windowMs) failures.delete(employeeId);
  }

  function recordFailure(employeeId: string): void {
    const timestamp = now().getTime();
    const previous = failures.get(employeeId);
    const current = previous && timestamp - previous.windowStartedAt < rateLimit.windowMs
      ? previous
      : { count: 0, windowStartedAt: timestamp, blockedUntil: 0 };
    current.count += 1;
    if (current.count >= rateLimit.maxFailures) current.blockedUntil = timestamp + rateLimit.windowMs;
    failures.set(employeeId, current);
    if (failures.size > 10_000) {
      for (const [key, value] of failures) {
        if (value.blockedUntil <= timestamp && timestamp - value.windowStartedAt >= rateLimit.windowMs) {
          failures.delete(key);
        }
      }
      for (const key of failures.keys()) {
        if (failures.size <= 10_000) break;
        failures.delete(key);
      }
    }
  }

  async function login(input: { employeeId: string; password: string }): Promise<LoginResult> {
    let employeeId: string;
    try {
      employeeId = validateEmployeeId(input.employeeId);
    } catch {
      throw new TeamAuthError('invalid_credentials', '工号或凭据无效。', 401);
    }
    checkRateLimit(employeeId);
    const user = userByEmployeeId(employeeId);
    const password = typeof input.password === 'string' ? input.password.slice(0, 512) : '';
    const valid = user ? await verifyPassword(password, user.passwordHash, kdf) : false;
    const timestamp = now();
    if (!user || !valid || user.status !== 'active'
      || (user.mustChangePassword === 1 && user.credentialExpiresAt
        && new Date(user.credentialExpiresAt).getTime() <= timestamp.getTime())) {
      recordFailure(employeeId);
      throw new TeamAuthError('invalid_credentials', '工号或凭据无效。', 401);
    }
    failures.delete(employeeId);
    const token = randomBytes(32).toString('base64url');
    const session: SessionRow = {
      id: randomUUID(),
      userId: user.id,
      sessionVersion: user.sessionVersion,
      absoluteExpiresAt: new Date(timestamp.getTime() + SESSION_DURATION_MS).toISOString(),
    };
    db.prepare(`
      INSERT INTO team_sessions (id, tokenHash, userId, sessionVersion, createdAt, absoluteExpiresAt, revokedAt)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(session.id, tokenHash(token), session.userId, session.sessionVersion,
      timestamp.toISOString(), session.absoluteExpiresAt);
    return { principal: principalFrom(user, session), token };
  }

  function resolveSession(token: string): AuthPrincipal | null {
    if (!token || token.length > 256) return null;
    const session = db.prepare(`
      SELECT * FROM team_sessions WHERE tokenHash = ? AND revokedAt IS NULL
    `).get(tokenHash(token)) as SessionRow | undefined;
    if (!session || new Date(session.absoluteExpiresAt).getTime() <= now().getTime()) return null;
    const user = userById(session.userId);
    if (!user || user.status !== 'active' || user.sessionVersion !== session.sessionVersion) return null;
    return principalFrom(user, session);
  }

  async function changeOwnPassword(
    principal: AuthPrincipal,
    currentPassword: string,
    newPassword: string,
  ): Promise<AuthPrincipal> {
    assertIdentityOperationAllowed(principal, 'change-password');
    const user = currentUserForSession(principal);
    validateNewPassword(newPassword);
    if (!await verifyPassword(currentPassword, user.passwordHash, kdf)) {
      throw new TeamAuthError('invalid_credentials', '当前密码或一次性凭据无效。', 401);
    }
    const nextHash = await hashPassword(newPassword, kdf, passwordParams);
    const timestamp = now().toISOString();
    const change = db.transaction(() => {
      currentUserForSession(principal);
      const nextVersion = user.sessionVersion + 1;
      db.prepare(`
        UPDATE team_users
        SET passwordHash = ?, mustChangePassword = 0, credentialExpiresAt = NULL,
            sessionVersion = ?, updatedAt = ?
        WHERE id = ?
      `).run(nextHash, nextVersion, timestamp, user.id);
      db.prepare(`
        UPDATE team_sessions SET revokedAt = ? WHERE userId = ? AND id <> ? AND revokedAt IS NULL
      `).run(timestamp, user.id, principal.sessionId);
      const kept = db.prepare(`
        UPDATE team_sessions SET sessionVersion = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL
      `).run(nextVersion, principal.sessionId, user.id);
      if (kept.changes !== 1) throw new TeamAuthError('session_invalid', '登录状态已失效，请重新登录。', 401);
      return nextVersion;
    });
    const nextVersion = change.immediate();
    return {
      ...principal,
      sessionVersion: nextVersion,
      mustChangePassword: false,
    };
  }

  function logout(principal: AuthPrincipal): void {
    assertIdentityOperationAllowed(principal, 'logout');
    db.prepare('UPDATE team_sessions SET revokedAt = ? WHERE id = ? AND userId = ? AND revokedAt IS NULL')
      .run(now().toISOString(), principal.sessionId, principal.userId);
  }

  async function issueCredential(): Promise<{ credential: string; passwordHash: string; expiresAt: string }> {
    const credential = generateOneTimeCredential();
    return {
      credential,
      passwordHash: await hashPassword(credential, kdf, passwordParams),
      expiresAt: new Date(now().getTime() + CREDENTIAL_DURATION_MS).toISOString(),
    };
  }

  async function initializeFirstAdministrator(input: { employeeId: string; displayName: string }) {
    const employeeId = validateEmployeeId(input.employeeId);
    const displayName = validateDisplayName(input.displayName);
    if ((db.prepare('SELECT COUNT(*) AS count FROM team_users').get() as { count: number }).count > 0) {
      throw new TeamAuthError('admin_already_initialized', '首个管理员已初始化。', 409);
    }
    const id = randomUUID();
    const timestamp = now().toISOString();
    const issued = await issueCredential();
    const create = db.transaction(() => {
      if ((db.prepare('SELECT COUNT(*) AS count FROM team_users').get() as { count: number }).count > 0) {
        throw new TeamAuthError('admin_already_initialized', '首个管理员已初始化。', 409);
      }
      db.prepare(`
        INSERT INTO team_users (
          id, employeeId, displayName, role, status, passwordHash, mustChangePassword,
          credentialExpiresAt, sessionVersion, createdAt, updatedAt
        ) VALUES (?, ?, ?, 'admin', 'active', ?, 1, ?, 1, ?, ?)
      `).run(id, employeeId, displayName, issued.passwordHash, issued.expiresAt, timestamp, timestamp);
    });
    create.immediate();
    return { user: userView(userById(id)!), credential: issued.credential };
  }

  async function createUser(actor: AuthPrincipal, input: {
    employeeId: string;
    displayName: string;
    role: TeamRole;
  }): Promise<{ user: TeamUserView; credential: string }> {
    const employeeId = validateEmployeeId(input.employeeId);
    const displayName = validateDisplayName(input.displayName);
    if (!['employee', 'admin'].includes(input.role)) throw new TeamAuthError('invalid_role', '角色无效。');
    requireAdmin(actor);
    const id = randomUUID();
    const timestamp = now().toISOString();
    const issued = await issueCredential();
    const create = db.transaction(() => {
      requireAdmin(actor);
      try {
        db.prepare(`
          INSERT INTO team_users (
            id, employeeId, displayName, role, status, passwordHash, mustChangePassword,
            credentialExpiresAt, sessionVersion, createdAt, updatedAt
          ) VALUES (?, ?, ?, ?, 'active', ?, 1, ?, 1, ?, ?)
        `).run(id, employeeId, displayName, input.role, issued.passwordHash, issued.expiresAt, timestamp, timestamp);
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE')) {
          throw new TeamAuthError('employee_id_exists', '工号已存在。', 409);
        }
        throw error;
      }
    });
    create.immediate();
    return { user: userView(userById(id)!), credential: issued.credential };
  }

  function listUsers(actor: AuthPrincipal): TeamUserView[] {
    requireAdmin(actor);
    return (db.prepare('SELECT * FROM team_users ORDER BY employeeId').all() as UserRow[]).map(userView);
  }

  async function resetUserCredential(actor: AuthPrincipal, userId: string) {
    requireAdmin(actor);
    const target = userById(userId);
    if (!target) throw new TeamAuthError('user_not_found', '账号不存在。', 404);
    const issued = await issueCredential();
    const reset = db.transaction(() => {
      requireAdmin(actor);
      const current = userById(userId);
      if (!current) throw new TeamAuthError('user_not_found', '账号不存在。', 404);
      const timestamp = now().toISOString();
      db.prepare(`
        UPDATE team_users SET passwordHash = ?, mustChangePassword = 1, credentialExpiresAt = ?,
          sessionVersion = sessionVersion + 1, updatedAt = ? WHERE id = ?
      `).run(issued.passwordHash, issued.expiresAt, timestamp, userId);
      db.prepare('UPDATE team_sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL')
        .run(timestamp, userId);
    });
    reset.immediate();
    return { user: userView(userById(userId)!), credential: issued.credential };
  }

  function protectLastAdmin(target: UserRow): void {
    if (target.role !== 'admin' || target.status !== 'active') return;
    const remaining = db.prepare(`
      SELECT COUNT(*) AS count FROM team_users
      WHERE role = 'admin' AND status = 'active' AND id <> ?
    `).get(target.id) as { count: number };
    if (remaining.count === 0) throw new TeamAuthError('last_admin_required', '必须保留至少一位可用管理员。', 409);
  }

  function setUserRole(actor: AuthPrincipal, userId: string, role: TeamRole): TeamUserView {
    if (!['employee', 'admin'].includes(role)) throw new TeamAuthError('invalid_role', '角色无效。');
    const update = db.transaction(() => {
      requireAdmin(actor);
      const target = userById(userId);
      if (!target) throw new TeamAuthError('user_not_found', '账号不存在。', 404);
      if (role !== 'admin') protectLastAdmin(target);
      db.prepare('UPDATE team_users SET role = ?, updatedAt = ? WHERE id = ?')
        .run(role, now().toISOString(), userId);
      return userView(userById(userId)!);
    });
    return update.immediate();
  }

  function setUserStatus(actor: AuthPrincipal, userId: string, status: TeamUserStatus): TeamUserView {
    if (!['active', 'disabled'].includes(status)) throw new TeamAuthError('invalid_status', '账号状态无效。');
    const update = db.transaction(() => {
      requireAdmin(actor);
      const target = userById(userId);
      if (!target) throw new TeamAuthError('user_not_found', '账号不存在。', 404);
      if (status === 'disabled') protectLastAdmin(target);
      const timestamp = now().toISOString();
      db.prepare(`
        UPDATE team_users SET status = ?, sessionVersion = sessionVersion + ?, updatedAt = ? WHERE id = ?
      `).run(status, status === 'disabled' ? 1 : 0, timestamp, userId);
      if (status === 'disabled') {
        db.prepare('UPDATE team_sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL')
          .run(timestamp, userId);
      }
      return userView(userById(userId)!);
    });
    return update.immediate();
  }

  async function recoverAdministrator(employeeIdInput: string) {
    const employeeId = validateEmployeeId(employeeIdInput);
    const target = userByEmployeeId(employeeId);
    if (!target) throw new TeamAuthError('user_not_found', '恢复命令要求既有账号；首管理员请使用初始化命令。', 404);
    const issued = await issueCredential();
    const recover = db.transaction(() => {
      const current = userByEmployeeId(employeeId);
      if (!current) throw new TeamAuthError('user_not_found', '账号不存在。', 404);
      const timestamp = now().toISOString();
      db.prepare(`
        UPDATE team_users SET role = 'admin', status = 'active', passwordHash = ?,
          mustChangePassword = 1, credentialExpiresAt = ?, sessionVersion = sessionVersion + 1,
          updatedAt = ? WHERE id = ?
      `).run(issued.passwordHash, issued.expiresAt, timestamp, current.id);
      db.prepare('UPDATE team_sessions SET revokedAt = ? WHERE userId = ? AND revokedAt IS NULL')
        .run(timestamp, current.id);
    });
    recover.immediate();
    return { user: userView(userByEmployeeId(employeeId)!), credential: issued.credential };
  }

  return {
    login,
    resolveSession,
    changeOwnPassword,
    logout,
    initializeFirstAdministrator,
    createUser,
    listUsers,
    resetUserCredential,
    setUserRole,
    setUserStatus,
    recoverAdministrator,
  };
}

export type TeamAuthService = ReturnType<typeof createTeamAuthService>;
