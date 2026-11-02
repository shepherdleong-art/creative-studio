import type Database from 'better-sqlite3';
import type { SchemaUpgradeDiskSpaceProbe } from '../schema-upgrade/backup.ts';
import type { SchemaUpgradeGateReadiness } from '../schema-upgrade/gate.ts';
import {
  checkExecutionReadiness,
} from '../media-core/execution/readiness.ts';
import {
  registerExecutionInstance,
} from '../media-core/execution/schema.ts';
import type {
  ExecutionInstanceIdentity,
  ExecutionModuleContext,
  ExecutionModuleLifecycle,
} from '../media-core/execution/contracts.ts';
import type { ServerRuntimeConfig } from './config.ts';
import { checkTeamServiceReadiness } from './readiness.ts';
import {
  initializeTeamRuntimeState,
  markTeamRuntimeFailed,
  setTeamRuntimePhase,
} from './runtime/state.ts';

export class TeamRuntimeReadinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TeamRuntimeReadinessError';
    this.code = code;
  }
}

export interface TeamServiceBootstrap {
  ensureSchemaReady(): Promise<void>;
  registerRecovery(): Promise<void>;
  recover(): Promise<void>;
  start(): Promise<void>;
  drain(): Promise<{ stopped: boolean; pendingTasks: number }>;
}

export interface BusinessReadiness {
  available: boolean;
  code?: string;
  message?: string;
}

function readinessFailure(readiness: SchemaUpgradeGateReadiness): never {
  if (readiness.available) throw new Error('unexpected readiness failure');
  throw new TeamRuntimeReadinessError(readiness.code, readiness.message);
}

export function createTeamServiceBootstrap(options: {
  config: ServerRuntimeConfig;
  identity: ExecutionInstanceIdentity;
  db: Database.Database;
  backupRoot: string;
  lockDatabasePath: string;
  auditFilePath: string;
  modules?: ReadonlyArray<ExecutionModuleLifecycle>;
  diskSpaceProbe?: SchemaUpgradeDiskSpaceProbe;
  assertOwnerActive?: () => void;
  checkBusinessReadiness?: () => Promise<BusinessReadiness>;
}): TeamServiceBootstrap {
  const modules = options.modules ?? [];
  const checkBusinessReadiness = options.checkBusinessReadiness ?? (async () => ({
    available: true,
  }));
  const controller = new AbortController();
  const context: ExecutionModuleContext = {
    deploymentId: options.config.deploymentId,
    instanceId: options.identity.instanceId,
    fence: options.identity.fence,
    signal: controller.signal,
  };
  let stage = 0;
  let drainPromise: Promise<{ stopped: boolean; pendingTasks: number }> | null = null;

  function active(): void {
    options.assertOwnerActive?.();
  }

  function failed(error: unknown): never {
    const code = error instanceof TeamRuntimeReadinessError ? error.code : 'bootstrap_failed';
    markTeamRuntimeFailed(code);
    throw error;
  }

  async function ensureSchemaReady(): Promise<void> {
    if (stage >= 1) return;
    if (stage !== 0) throw new Error('必须先成功执行 ensureSchemaReady');
    active();
    setTeamRuntimePhase('migrating', { ready: false, maintenance: true });
    try {
      const sharedOptions = {
        db: options.db,
        backupRoot: options.backupRoot,
        lockDatabasePath: options.lockDatabasePath,
        auditFilePath: options.auditFilePath,
        diskSpaceProbe: options.diskSpaceProbe,
      };
      const team = await checkTeamServiceReadiness(sharedOptions);
      if (!team.available) readinessFailure(team);
      const execution = await checkExecutionReadiness(sharedOptions);
      if (!execution.available) readinessFailure(execution);
      for (const lifecycle of modules) await lifecycle.ensureSchemaReady();
      stage = 1;
      setTeamRuntimePhase('schema_ready', { ready: false, maintenance: true });
    } catch (error) {
      failed(error);
    }
  }

  async function registerRecovery(): Promise<void> {
    if (stage >= 2) return;
    if (stage !== 1) throw new Error('必须先成功执行 ensureSchemaReady，再调用 registerRecovery');
    active();
    setTeamRuntimePhase('registering_recovery', { ready: false, maintenance: true });
    try {
      registerExecutionInstance(options.db, {
        ...options.identity,
        deploymentId: options.config.deploymentId,
      });
      for (const lifecycle of modules) await lifecycle.registerRecovery(context);
      const business = await checkBusinessReadiness();
      if (!business.available) {
        throw new TeamRuntimeReadinessError(
          business.code ?? 'business_unavailable',
          business.message ?? '业务 readiness 不可用。',
        );
      }
      stage = 2;
      setTeamRuntimePhase('recovery_registered', { ready: false, maintenance: true });
    } catch (error) {
      failed(error);
    }
  }

  async function recover(): Promise<void> {
    if (stage >= 3) return;
    if (stage !== 2) throw new Error('必须先成功执行 registerRecovery，再调用 recover');
    active();
    setTeamRuntimePhase('recovering', { ready: false, maintenance: true });
    try {
      for (const lifecycle of modules) await lifecycle.recover(context);
      stage = 3;
      setTeamRuntimePhase('recovered', { ready: false, maintenance: true });
    } catch (error) {
      failed(error);
    }
  }

  async function start(): Promise<void> {
    if (stage >= 4) return;
    if (stage !== 3) throw new Error('必须先成功执行 ensureSchemaReady / registerRecovery / recover');
    active();
    setTeamRuntimePhase('starting', { ready: false, maintenance: true });
    try {
      for (const lifecycle of modules) await lifecycle.start(context);
      stage = 4;
      setTeamRuntimePhase('ready', { ready: true, maintenance: false, code: undefined });
    } catch (error) {
      failed(error);
    }
  }

  function drain(): Promise<{ stopped: boolean; pendingTasks: number }> {
    if (drainPromise) return drainPromise;
    setTeamRuntimePhase('draining', { ready: false, maintenance: true });
    if (!controller.signal.aborted) controller.abort(new Error('team runtime draining'));
    drainPromise = (async () => {
      let pendingTasks = 0;
      for (const lifecycle of [...modules].reverse()) {
        try {
          pendingTasks += Math.max(0, await lifecycle.drain?.(context) ?? 0);
        } catch {
          pendingTasks += 1;
        }
      }
      if (stage >= 2) {
        try {
          options.db.prepare(`
            UPDATE execution_instances SET stoppedAt = ? WHERE instanceId = ? AND fence = ?
          `).run(new Date().toISOString(), options.identity.instanceId, options.identity.fence);
        } catch {
          pendingTasks += 1;
        }
      }
      stage = 5;
      setTeamRuntimePhase('stopped', { ready: false, maintenance: true });
      return { stopped: pendingTasks === 0, pendingTasks };
    })();
    return drainPromise;
  }

  initializeTeamRuntimeState(options.identity);
  return { ensureSchemaReady, registerRecovery, recover, start, drain };
}
