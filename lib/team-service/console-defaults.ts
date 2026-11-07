import { readRuntimeConfig } from './config.ts';
import type { ConsoleProductionDefaults } from '../team-console-overview.ts';

/**
 * 服务器默认参数的**只读**取值缝（12 号票）。
 *
 * 数据归属：06 号票把「超时 / 项目并发 / 视频并发 / 图片预处理」写进服务器运行配置
 * （`lib/team-service/config.ts` 的 `RuntimeConfig`，`mode:'server'` 分支加一段
 * `productionDefaults`）。**本文件不定义默认值、也不做任何裁决**，只把它读出来给控制台
 * 只读展示——用户已明确：控制台只读显示，不做修改界面。
 *
 * 为什么用「读运行配置上的可选字段」而不是直接 import 06 的模块：
 * - 06 与 12 并行实施，若 12 先合并，静态 import 一个还不存在的文件会直接让构建失败；
 * - 06 的接口名也还没冻结（`production-defaults.ts` 或扩展 `config.ts` 两种可能）。
 *
 * 所以这里只认一个**已经确认会存在**的落点：`readRuntimeConfig()` 返回对象上的
 * `productionDefaults`。06 一合并，这个函数自动读到值；没合并时返回 null，界面整块收起，
 * 绝不把缺省值伪造成「服务器已生效的默认值」。
 *
 * 合并后的验收方式：管理员打开运行总览，「服务器默认参数」块应显示 06 写入的真实取值；
 * 若 06 最终把值放在别处，只需改本函数一处（页面与测试都只看 `consoleDefaultsView`）。
 */
export function readProductionDefaults(): ConsoleProductionDefaults | null {
  const config = readRuntimeConfig();
  if (config.mode !== 'server') return null;
  const candidate = (config as unknown as Record<string, unknown>).productionDefaults;
  return normalizeProductionDefaults(candidate);
}

/**
 * 二级形状校验：只接受字段类型正确的对象，缺字段就整体当「没接上」。
 * 这样上游（06）以后多写字段不会影响这里，写错类型也不会被显示成默认值。
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
