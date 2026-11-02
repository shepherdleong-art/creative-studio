import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

export type ResourceAccessAction = 'read' | 'write';
export type AccessActorRole = 'employee' | 'admin';

export interface AccessActor {
  userId: string;
  role: AccessActorRole;
}

export interface ResourceRef {
  resourceType: string;
  resourceId: string;
}

export interface RootScopeRegistration extends ResourceRef {
  ownerUserId: string;
  visibility?: 'private' | 'public';
}

export interface InheritedScopeRegistration extends ResourceRef {
  parent: ResourceRef;
  visibility?: 'private' | 'public';
}

export interface TaskPrincipalRegistration {
  module: string;
  taskId: string;
  actorUserId?: string;
  scope: ResourceRef;
  creationSnapshot?: unknown;
}

/**
 * 模块无关的访问端口。团队组合根注入真实实现；业务模块不得反向导入 team-service。
 */
export interface ResourceAccessContext {
  readonly kind: 'team' | 'local';
  readonly actor: AccessActor;
  assertAccess(resourceType: string, resourceId: string, action: ResourceAccessAction): void;
  resolveOwner(requestedOwnerUserId?: unknown): string;
  registerRootScope(input: RootScopeRegistration): void;
  registerInheritedScope(input: InheritedScopeRegistration): void;
  registerTaskPrincipal(input: TaskPrincipalRegistration): void;
}

const storage = new AsyncLocalStorage<ResourceAccessContext>();
const INJECTION_KEY = Symbol.for('creative-studio.resource-access-context');
const TASK_INJECTION_KEY = Symbol.for('creative-studio.task-access-context-factory');
type TaskAccessContextFactory = (db: Database.Database, module: string, taskId: string) => ResourceAccessContext;

function globalInjection(): ResourceAccessContext | null {
  return (globalThis as unknown as Record<symbol, ResourceAccessContext | undefined>)[INJECTION_KEY] ?? null;
}

export function setResourceAccessContext(context: ResourceAccessContext | null): void {
  const globals = globalThis as unknown as Record<symbol, ResourceAccessContext | undefined>;
  if (context) globals[INJECTION_KEY] = context;
  else delete globals[INJECTION_KEY];
}

export function runWithAccessContext<T>(context: ResourceAccessContext, operation: () => T): T {
  return storage.run(context, operation);
}

const LOCAL_ACTOR: AccessActor = { userId: 'local', role: 'admin' };

/** 显式 local 兼容实现，不保存团队身份，也不伪造 server scope。 */
export function createLocalAccessContext(): ResourceAccessContext {
  return {
    kind: 'local',
    actor: LOCAL_ACTOR,
    assertAccess() {},
    resolveOwner() { return LOCAL_ACTOR.userId; },
    registerRootScope() {},
    registerInheritedScope() {},
    registerTaskPrincipal() {},
  };
}

export function optionalAccessContext(): ResourceAccessContext | null {
  const contextual = storage.getStore() ?? globalInjection();
  if (contextual) return contextual;
  if ((process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local') === 'local') {
    return createLocalAccessContext();
  }
  return null;
}

export function requireAccessContext(context?: ResourceAccessContext | null): ResourceAccessContext {
  const resolved = context ?? optionalAccessContext();
  if (!resolved) throw new Error('server 模式缺少已验证的访问上下文，已拒绝执行。');
  return resolved;
}

export function setTaskAccessContextFactory(factory: TaskAccessContextFactory | null): void {
  const globals = globalThis as unknown as Record<symbol, TaskAccessContextFactory | undefined>;
  if (factory) globals[TASK_INJECTION_KEY] = factory;
  else delete globals[TASK_INJECTION_KEY];
}

/** 后台任务从持久 principal 重建主体；server 缺注入时 fail closed。 */
export function runWithTaskAccessContext<T>(
  db: Database.Database,
  module: string,
  taskId: string,
  operation: () => T,
): T {
  if ((process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local') === 'local') return operation();
  const factory = (globalThis as unknown as Record<symbol, TaskAccessContextFactory | undefined>)[TASK_INJECTION_KEY];
  if (!factory) throw new Error('server 模式缺少持久任务访问上下文注入，已拒绝执行。');
  return runWithAccessContext(factory(db, module, taskId), operation);
}
