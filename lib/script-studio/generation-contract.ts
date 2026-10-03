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

/** 前端「生成数量」下拉的稳定产品选项，1 到上限的连续整数。 */
export const SCRIPT_GENERATION_UI_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

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

export type ScriptProductionMode = 'standard' | 'pain_solving_15s' | 'template_rewrite';
export function parseScriptProductionMode(value: unknown, duration: number): ScriptProductionMode {
  if (value === undefined || value === 'standard') return 'standard';
  if (value === 'pain_solving_15s') {
    if (duration !== 15) throw new ScriptStudioError('invalid_input', '痛点解决型目前仅支持15秒');
    return value;
  }
  // 爆文模板改写：时长沿用共享白名单（15/20/30/45/60），不照搬源项目 5–600 秒范围。
  if (value === 'template_rewrite') return value;
  throw new ScriptStudioError('invalid_input', '不支持的脚本生产模式');
}

/**
 * 爆文模板改写的模板选择校验（A03）：展开后 1–上限条、数量与生成数量一致。
 * 同一模板可重复出现，重复次数即该模板的生成条数（同一爆文结构产多条变体供挑选）。
 * 纯形状校验，不查库；条目存在性与可用状态由路由在库层校验。
 */
export function parseTemplateRewriteEntryIds(value: unknown, requestedCount: number): string[] {
  const entryIds = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  if (entryIds.length === 0) throw new ScriptStudioError('invalid_input', '爆文模板改写需要勾选 1-6 个模板');
  if (entryIds.length > SCRIPT_GENERATION_MAX_COUNT) {
    throw new ScriptStudioError('invalid_input', `一次最多生成 ${SCRIPT_GENERATION_MAX_COUNT} 条（同一模板可重复多条）`);
  }
  if (entryIds.length !== requestedCount) {
    throw new ScriptStudioError('invalid_input', '生成数量必须与模板条数一致（每个模板按所选条数生成）');
  }
  return entryIds;
}
