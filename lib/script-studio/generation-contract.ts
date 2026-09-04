import { ScriptStudioError } from './errors.ts';

/**
 * 脚本生成参数的共享契约：纯模块，不读 process.env、不依赖 Node 环境，
 * 前后端（组件 / route / runner / planner / createTask）都可直接导入。
 *
 * 生成数量是「每条方案一次独立 LLM 调用」的有界并行，不是一次调用出多条，
 * 所以这里的上限只约束单批方案的条数，与 limits.ts 的 generationConcurrency 无关。
 */

/** 脚本一次生成的最大并列方案数。 */
export const SCRIPT_GENERATION_MAX_COUNT = 6;

/** 前端「生成数量」下拉的稳定产品选项（是否补 4 属产品决策，不在本期范围）。 */
export const SCRIPT_GENERATION_UI_OPTIONS = [1, 2, 3, 5, 6] as const;

/** 目标时长白名单（秒），route / runner / 再生成控件共用。 */
export const SCRIPT_TARGET_DURATION_OPTIONS = [15, 20, 30, 45, 60] as const;

/**
 * 解析并校验生成数量。允许可安全转成数值的整数，但**不先 Math.floor**：
 * 1.5、0、7、NaN 等一律拒绝并抛统一错误，避免调用方各自复制范围判断或静默钳制。
 */
export function parseScriptStudioRequestedCount(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(num) || num < 1 || num > SCRIPT_GENERATION_MAX_COUNT) {
    throw new ScriptStudioError('invalid_input', `生成数量必须是 1-${SCRIPT_GENERATION_MAX_COUNT} 的整数`);
  }
  return num;
}

/** 解析并校验目标时长，必须是白名单内的秒数。 */
export function parseScriptStudioTargetDuration(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!SCRIPT_TARGET_DURATION_OPTIONS.includes(num as (typeof SCRIPT_TARGET_DURATION_OPTIONS)[number])) {
    throw new ScriptStudioError('invalid_input', '目标时长仅支持 15、20、30、45 或 60 秒');
  }
  return num;
}
