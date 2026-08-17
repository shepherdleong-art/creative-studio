import {
  ScriptGenerationShuttingDownError,
  type ScriptGenerationSnapshot,
  type ScriptGenerationStartResult,
} from './script-generation-manager.ts';

// ── 可注入依赖的 script-generation 路由行为 ──
// Next route 只负责注入真实 manager/数据库并转发；动态测试直接调用本模块。

export interface ScriptGenerationRouteDeps {
  projectExists(): boolean;
  isShuttingDown(): boolean;
  start(body: Record<string, unknown>): ScriptGenerationStartResult;
  getCurrent(): ScriptGenerationSnapshot | null;
  cancel(generationId: string): boolean;
}

export interface ScriptGenerationRouteResponse {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

/** POST：启动或取得当前任务。新任务与幂等命中都返回 202。 */
export function handleScriptGenerationPost(
  deps: ScriptGenerationRouteDeps,
  body: unknown,
): ScriptGenerationRouteResponse {
  if (deps.isShuttingDown()) {
    return {
      status: 503,
      body: {
        error: 'script_generation_shutting_down',
        message: '服务正在关闭，无法开始新的脚本生成',
      },
    };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, body: { error: '请求体必须是 JSON 对象' } };
  }
  const generationId = (body as Record<string, unknown>).generationId;
  if (typeof generationId !== 'string' || !generationId) {
    return { status: 400, body: { error: '缺少生成任务 ID' } };
  }
  if (!deps.projectExists()) {
    return { status: 404, body: { error: 'Project not found' } };
  }
  try {
    const { created, snapshot } = deps.start(body as Record<string, unknown>);
    return {
      status: 202,
      body: {
        created,
        generation: { generationId: snapshot.generationId, state: snapshot.state },
      },
    };
  } catch (error) {
    if (error instanceof ScriptGenerationShuttingDownError) {
      return {
        status: 503,
        body: { error: error.code, message: error.message },
      };
    }
    throw error;
  }
}

/** GET：查询项目当前/最近任务。 */
export function handleScriptGenerationGet(
  deps: ScriptGenerationRouteDeps,
): ScriptGenerationRouteResponse {
  return {
    status: 200,
    body: { generation: deps.getCurrent() },
    headers: NO_STORE,
  };
}

/** DELETE：显式取消。已终态幂等返回当前状态；不存在或跨项目 404。 */
export function handleScriptGenerationDelete(
  deps: ScriptGenerationRouteDeps,
  generationId: unknown,
): ScriptGenerationRouteResponse {
  if (typeof generationId !== 'string' || !generationId) {
    return { status: 400, body: { error: '缺少生成任务 ID' } };
  }
  const current = deps.getCurrent();
  if (!current || current.generationId !== generationId) {
    return { status: 404, body: { error: '生成任务不存在或不属于当前项目' } };
  }
  if (current.state === 'running') {
    deps.cancel(generationId);
    return { status: 200, body: { generation: deps.getCurrent() } };
  }
  return { status: 200, body: { generation: current } };
}
