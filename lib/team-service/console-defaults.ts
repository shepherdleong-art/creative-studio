import { readRuntimeConfig } from './config.ts';
import type { ConsoleProductionDefaults } from '../team-console-overview.ts';

/**
 * 服务器默认参数的**只读**取值（12 号票）。
 *
 * 数据归属：06 号票把「超时 / 项目并发 / 视频并发 / 图片预处理」写进服务器运行配置
 * （`lib/team-service/config.ts` 的 `RuntimeConfig`，`mode:'server'` 分支的
 * `productionDefaults`，权威默认值在 `lib/team-service/production-defaults.ts`）。
 *
 * 并发数字是旧项目兼容存值；concurrencyMode 告知视图显示「按名额池调度」。
 * **本文件不定义默认值、也不做任何裁决**，只把它读出来给控制台只读展示——
 * 用户已明确：控制台只读显示，不做修改界面。这里也不重新实现 06 的归一化逻辑：
 * `readRuntimeConfig()` 返回的已经是归一化后的值（`normalizeProductionDefaults` 在 06 那边）。
 *
 * 06 尚未合并时 `productionDefaults` 字段不存在，返回 null，界面整块收起，
 * 绝不把缺省值伪造成「服务器已生效的默认值」。
 */
export function readProductionDefaults(): ConsoleProductionDefaults | null {
  const config = readRuntimeConfig();
  if (config.mode !== 'server') return null;
  return normalizeProductionDefaults(config.productionDefaults);
}

/**
 * 二级形状校验：只接受字段类型正确的对象，缺关键字段就整体当「没接上」。
 * 这样上游以后多写字段不影响这里，写错类型也不会被显示成生效值。
 */
export function normalizeProductionDefaults(value: unknown): ConsoleProductionDefaults | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const positive = (candidate: unknown): candidate is number =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0;
  if (!positive(source.timeoutMs) || !positive(source.projectConcurrency)) return null;
  const preprocess = source.imagePreprocess;
  const normalized: ConsoleProductionDefaults = {
    timeoutMs: source.timeoutMs,
    projectConcurrency: source.projectConcurrency,
    concurrencyMode: 'shared-pool',
  };
  if (positive(source.videoConcurrency)) normalized.videoConcurrency = source.videoConcurrency;
  if (preprocess && typeof preprocess === 'object') {
    const options = preprocess as Record<string, unknown>;
    if (typeof options.enabled === 'boolean') {
      normalized.imagePreprocess = {
        enabled: options.enabled,
        targetMaxSide: positive(options.targetMaxSide) ? options.targetMaxSide : 0,
        jpegQuality: positive(options.jpegQuality) ? options.jpegQuality : 0,
      };
    }
  }
  return normalized;
}
