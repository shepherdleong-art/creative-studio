import type Database from 'better-sqlite3';
import { BoundedKdfScheduler, createTeamAuthService } from './service.ts';
import type { ScryptParams } from './passwords.ts';
import { publishBuiltinResources } from '../public-resources.ts';
import type { AuthPrincipal } from './types.ts';

interface LocalAdminOptions {
  db: Database.Database;
  employeeId: string;
  displayName?: string;
  now?: () => Date;
  kdf?: BoundedKdfScheduler;
  passwordParams?: ScryptParams;
}

export async function initializeFirstAdministrator(options: LocalAdminOptions) {
  const service = createTeamAuthService(options);
  const result = await service.initializeFirstAdministrator({
    employeeId: options.employeeId,
    displayName: options.displayName ?? '系统管理员',
  });
  const principal: AuthPrincipal = {
    kind: 'user', userId: result.user.id, employeeId: result.user.employeeId,
    displayName: result.user.displayName, role: 'admin', sessionId: 'bootstrap:first-admin',
    sessionVersion: 1, mustChangePassword: false,
    absoluteExpiresAt: result.user.credentialExpiresAt ?? '',
  };
  await publishBuiltinResources(options.db, principal);
  return result;
}

export function recoverAdministrator(options: LocalAdminOptions) {
  const service = createTeamAuthService(options);
  return service.recoverAdministrator(options.employeeId);
}
