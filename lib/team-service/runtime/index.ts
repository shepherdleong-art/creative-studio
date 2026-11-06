import { randomUUID } from 'node:crypto';
import { dataRoot } from '../../data-root.ts';
import { getDb } from '../../db.ts';
import { schemaUpgradeRuntimePaths } from '../../schema-upgrade/runtime.ts';
import { createTeamExecutionRuntime, createTeamServiceBootstrap, type TeamServiceBootstrap } from '../bootstrap.ts';
import { ExecutionError, type ExecutionFacade, type ExecutionRuntime } from '../../media-core/execution/context.ts';
import { clearExecutionModuleRuntime, setExecutionModuleRuntime } from '../../media-core/execution/module-runtime.ts';
import { createScriptGenerationV3Lifecycle } from '../../script-generation-v3-server.ts';
import { ensureServerDeploymentMarker, readRuntimeConfig } from '../config.ts';
import { acquireTeamRuntimeOwner, type TeamRuntimeOwner } from './owner.ts';
import { setLegacyMediaExecutionRuntime } from '../../legacy-media-execution.ts';
import { createLegacyMediaLifecycle } from '../../legacy-media-lifecycle.ts';
import { createCanvasExecutionLifecycle } from '../../creative-canvas/bootstrap.ts';
import { createFinalEditExecutionLifecycle } from '../../final-edit/lifecycle.ts';
import { createBatchProductionLifecycle } from '../../batch-production/bootstrap.ts';
import { createScriptStudioExecutionLifecycle } from '../../script-studio/bootstrap.ts';
import {
  getTeamRuntimeState,
  initializeTeamRuntimeState,
  markTeamRuntimeFailed,
  setTeamRuntimePhase,
  type TeamRuntimeState,
} from './state.ts';

let owner: TeamRuntimeOwner | null = null;
let bootstrap: TeamServiceBootstrap | null = null;
let execution: ExecutionRuntime | null = null;
let starting: Promise<TeamRuntimeState> | null = null;
let draining = false;

export function getTeamExecutionFacade(): ExecutionFacade {
  if (!execution || draining || !getTeamRuntimeState().ready) {
    throw new ExecutionError('execution_not_ready', 'server 执行上下文尚未就绪。');
  }
  return execution.facade;
}

export async function startTeamServiceRuntime(): Promise<TeamRuntimeState> {
  if (starting) return starting;
  starting = (async () => {
    const config = readRuntimeConfig();
    if (config.mode !== 'server') throw new Error('团队服务入口要求显式 server 模式');
    ensureServerDeploymentMarker(config);
    owner = await acquireTeamRuntimeOwner({
      dataRoot: config.dataRoot,
      instanceId: process.env.CREATIVE_STUDIO_INSTANCE_ID || randomUUID(),
    });
    initializeTeamRuntimeState(owner);
    try {
      const db = getDb();
      execution = createTeamExecutionRuntime({ config, db });
      setLegacyMediaExecutionRuntime({ facade: execution.facade, instance: owner });
      bootstrap = createTeamServiceBootstrap({
        config,
        identity: owner,
        db,
        execution,
        modules: [
          createFinalEditExecutionLifecycle(db),
          createScriptGenerationV3Lifecycle(db),
          createCanvasExecutionLifecycle({ db, execution: execution.facade }),
          createLegacyMediaLifecycle(),
          // 首版四类模块：批量与详情页脚本必须无需页面/API 触发即可恢复。
          createBatchProductionLifecycle({ db }),
          createScriptStudioExecutionLifecycle(db),
        ],
        ...schemaUpgradeRuntimePaths(dataRoot()),
        assertOwnerActive: () => {
          owner?.assertActive();
          if (draining) throw new Error('团队服务正在停机，停止后续启动阶段');
        },
      });
      await bootstrap.ensureSchemaReady();
      await bootstrap.registerRecovery();
      await bootstrap.recover();
      setExecutionModuleRuntime({
        facade: execution.facade,
        instanceId: owner.instanceId,
        fence: owner.fence,
      });
      await bootstrap.start();
    } catch (error) {
      clearExecutionModuleRuntime();
      execution?.closeNewWork();
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'bootstrap_failed';
      markTeamRuntimeFailed(code);
      console.error(`[team-service] 业务入口保持关闭：${code}`);
    }
    return getTeamRuntimeState();
  })();
  return starting;
}

export async function drainTeamRuntime(timeoutMs: number): Promise<number> {
  if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE !== 'server') return 0;
  draining = true;
  setTeamRuntimePhase('draining', { ready: false, maintenance: true });
  if (starting) await starting.catch(() => getTeamRuntimeState());
  if (!bootstrap) {
    setTeamRuntimePhase('stopped', { ready: false, maintenance: true });
    return 0;
  }
  const deadline = Date.now() + Math.max(0, timeoutMs);
  const result = await Promise.race([
    bootstrap.drain(),
    new Promise<{ stopped: false; pendingTasks: number }>((resolve) => {
      const timer = setTimeout(() => resolve({ stopped: false, pendingTasks: 1 }), Math.max(0, deadline - Date.now()));
      timer.unref();
    }),
  ]);
  return result.pendingTasks;
}

export function releaseTeamRuntimeOwner(): void {
  draining = true;
  clearExecutionModuleRuntime();
  execution?.closeNewWork();
  execution = null;
  setLegacyMediaExecutionRuntime(null);
  owner?.release();
  owner = null;
  if (process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE === 'server') {
    setTeamRuntimePhase('stopped', { ready: false, maintenance: true });
  }
}
