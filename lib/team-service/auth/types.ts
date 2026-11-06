export type TeamRole = 'employee' | 'admin';
export type TeamUserStatus = 'active' | 'disabled';

export interface AuthPrincipal {
  kind: 'user';
  userId: string;
  employeeId: string;
  displayName: string;
  role: TeamRole;
  sessionId: string;
  sessionVersion: number;
  mustChangePassword: boolean;
  absoluteExpiresAt: string;
}

export interface TeamUserView {
  id: string;
  employeeId: string;
  displayName: string;
  role: TeamRole;
  status: TeamUserStatus;
  mustChangePassword: boolean;
  credentialExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InternalTaskPrincipal {
  kind: 'internal_task';
  actorUserId: string;
  employeeId: string;
  roleAtAcceptance: TeamRole;
  module: string;
  taskId: string;
  acceptedAt: string;
}

export type IdentityOperation = 'session' | 'csrf' | 'change-password' | 'logout' | 'business' | 'users';

const AUTH_ERROR_BRAND = Symbol.for('creative-studio.team-auth-error');

export class TeamAuthError extends Error {
  readonly [AUTH_ERROR_BRAND] = true;
  readonly code: string;
  readonly status: number;

  // The process-wide auth service can be created by a different Next server bundle.
  // Constructor identity is not stable across those bundles; the private brand is.
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null
      && (value as TeamAuthError)[AUTH_ERROR_BRAND] === true;
  }

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TeamAuthError';
    this.code = code;
    this.status = status;
  }
}

export function assertIdentityOperationAllowed(
  principal: AuthPrincipal,
  operation: IdentityOperation,
): void {
  if (principal.mustChangePassword
    && !['session', 'csrf', 'change-password', 'logout'].includes(operation)) {
    throw new TeamAuthError('password_change_required', '首次改密后才能执行此操作。', 403);
  }
}

export function createInternalTaskPrincipal(
  principal: AuthPrincipal,
  task: { module: string; taskId: string; acceptedAt: string },
): InternalTaskPrincipal {
  assertIdentityOperationAllowed(principal, 'business');
  if (!task.module.trim() || !task.taskId.trim() || !task.acceptedAt.trim()) {
    throw new Error('内部任务主体必须绑定已受理任务');
  }
  return {
    kind: 'internal_task',
    actorUserId: principal.userId,
    employeeId: principal.employeeId,
    roleAtAcceptance: principal.role,
    module: task.module,
    taskId: task.taskId,
    acceptedAt: task.acceptedAt,
  };
}
