import type Database from 'better-sqlite3';
import { BoundedKdfScheduler, createTeamAuthService } from './service.ts';
import type { ScryptParams } from './passwords.ts';

interface LocalAdminOptions {
  db: Database.Database;
  employeeId: string;
  displayName?: string;
  now?: () => Date;
  kdf?: BoundedKdfScheduler;
  passwordParams?: ScryptParams;
}

export function initializeFirstAdministrator(options: LocalAdminOptions) {
  const service = createTeamAuthService(options);
  return service.initializeFirstAdministrator({
    employeeId: options.employeeId,
    displayName: options.displayName ?? '系统管理员',
  });
}

export function recoverAdministrator(options: LocalAdminOptions) {
  const service = createTeamAuthService(options);
  return service.recoverAdministrator(options.employeeId);
}
