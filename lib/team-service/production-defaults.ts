/**
 * 生产参数的唯一裁决点（06 号票）。
 *
 * 背景：团队版（`CREATIVE_STUDIO_DEPLOYMENT_MODE=server`）里，超时、并发、
 * 图片预处理（开关 / 最长边 / 压缩质量）由服务器统一管理。客户端请求里带
 * 这些字段也一律丢弃——旧客户端同样受管。个人本地版保持改动前的语义：
 * 请求里有值就用请求值，没值回退到同一套内置默认值。
 *
 * 这里是纯函数 + 纯数据：不 import `sharp`、不读环境变量、不碰数据库。
 * 服务器默认值的落地位置是 `lib/team-service/config.ts` 的 server 分支
 * （`RuntimeConfig.productionDefaults`），本文件只提供起步默认值与裁决规则。
 *
 * server 图片/视频队列的 worker 数按实际名额池容量与任务需求决定，不再把
 * 项目中保存的并发数字当上限。名额池 / 成员并发上限 / 公平共享（ADR-0001）
 * 仍由 execution 准入执行；worker 数不授予付费提交权限。
 */

export type DeploymentMode = 'local' | 'server';

export interface ProductionDefaults {
  /** 单条图片任务的超时（毫秒）。 */
  timeoutMs: number;
  /** 本地图片队列默认并发；server 仅保留为项目兼容存值，执行按名额池调度。 */
  projectConcurrency: number;
  /** 本地视频队列默认并发（1–10）；server 执行按名额池调度。 */
  videoConcurrency: number;
  imagePreprocess: {
    enabled: boolean;
    targetMaxSide: number;
    jpegQuality: number;
  };
}

/** 请求里可能带来的生产参数字段（HTTP body / multipart form 都可能是字符串）。 */
export interface RequestedProductionParams {
  timeoutMs?: unknown;
  concurrency?: unknown;
  videoConcurrency?: unknown;
  preprocessEnabled?: unknown;
  targetMaxSide?: unknown;
  jpegQuality?: unknown;
}

export interface ResolvedProductionParams {
  timeoutMs: number;
  projectConcurrency: number;
  videoConcurrency: number;
  imagePreprocess: {
    enabled: boolean;
    targetMaxSide: number;
    jpegQuality: number;
  };
}

/**
 * 起步默认值 = 改动前客户端的默认值：
 * 超时 600000ms、本地项目/视频并发 10、预处理开启、最长边 1536、质量 85。
 * server 保留并发数字供旧项目/API 兼容，实际 worker 数使用 resolveQueueWorkerCount。
 *
 * 最长边与质量必须与 `lib/image-preprocess.ts` 的 `DEFAULT_OPTIONS` 一致；
 * 这里刻意不 import 那个模块（它会拉起 `sharp`），改由
 * `scripts/production-defaults.test.ts` 断言两边相等，谁先漂移谁红。
 */
export const BUILTIN_PRODUCTION_DEFAULTS: ProductionDefaults = {
  timeoutMs: 600_000,
  projectConcurrency: 10,
  videoConcurrency: 10,
  imagePreprocess: {
    enabled: true,
    targetMaxSide: 1536,
    jpegQuality: 85,
  },
};

export interface QueuePoolDemand {
  capacity: number;
  taskCount: number;
}

/** Pool aliases must be merged before calling; zero/disabled pools still need one waiting worker. */
export function resolveQueueWorkerCount(input: {
  mode: DeploymentMode;
  concurrency?: number;
  poolDemands?: QueuePoolDemand[];
}): number {
  if (input.mode === 'local') return input.concurrency ?? BUILTIN_PRODUCTION_DEFAULTS.projectConcurrency;
  return (input.poolDemands ?? []).reduce((count, pool) =>
    count + Math.min(pool.taskCount, Math.max(1, pool.capacity)), 0);
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function booleanFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  }
  return null;
}

function clampVideoConcurrency(value: number): number {
  return Math.max(1, Math.min(10, Math.floor(value)));
}

/**
 * 集中裁决。`mode==='server'` 时完全丢弃 `requested`；`mode==='local'` 时
 * 沿用改动前的「有值用值、缺省回退」语义。
 *
 * 注意：本地版也做最基本的合法化（正整数 / 布尔），因为请求可能来自表单字符串；
 * 数值上限（项目并发 1–10、视频并发 1–10）仍由调用点原有的钳制负责，行为不变。
 */
export function resolveProductionParams(input: {
  mode: DeploymentMode;
  requested?: RequestedProductionParams;
  defaults?: ProductionDefaults;
}): ResolvedProductionParams {
  const defaults = input.defaults ?? BUILTIN_PRODUCTION_DEFAULTS;
  const serverMode = input.mode === 'server';
  const requested = input.requested ?? {};

  if (serverMode) {
    return {
      timeoutMs: defaults.timeoutMs,
      projectConcurrency: defaults.projectConcurrency,
      videoConcurrency: Math.max(1, Math.floor(defaults.videoConcurrency)),
      imagePreprocess: { ...defaults.imagePreprocess },
    };
  }

  const timeoutMs = positiveNumber(requested.timeoutMs) ?? defaults.timeoutMs;
  const projectConcurrency = positiveNumber(requested.concurrency) ?? defaults.projectConcurrency;
  const videoConcurrency = clampVideoConcurrency(positiveNumber(requested.videoConcurrency) ?? defaults.videoConcurrency);
  const enabled = booleanFlag(requested.preprocessEnabled) ?? defaults.imagePreprocess.enabled;
  return {
    timeoutMs,
    projectConcurrency,
    videoConcurrency,
    imagePreprocess: {
      enabled,
      targetMaxSide: positiveNumber(requested.targetMaxSide) ?? defaults.imagePreprocess.targetMaxSide,
      jpegQuality: positiveNumber(requested.jpegQuality) ?? defaults.imagePreprocess.jpegQuality,
    },
  };
}

/** 只取结构里需要的两个字段，避免本模块反向 import `config.ts`（会成环）。 */
export interface ProductionRuntimeConfig {
  mode: DeploymentMode;
  productionDefaults?: ProductionDefaults;
}

/**
 * 路由侧的便捷入口：读运行时配置里的服务器默认值，再按当前模式裁决。
 * 六个落点（建项目 / start / resume / upload / 三个视频队列入口）都走这里，
 * 保证「server 忽略请求值」只有一份实现。
 */
export function productionParamsFor(
  config: ProductionRuntimeConfig,
  requested?: RequestedProductionParams,
): ResolvedProductionParams {
  return resolveProductionParams({
    mode: config.mode,
    requested,
    defaults: config.mode === 'server' ? config.productionDefaults : undefined,
  });
}

/** 服务器默认值的最小校验：运行时配置写错时早失败，而不是把 0 并发带进队列。 */
export function normalizeProductionDefaults(
  value: (Partial<Omit<ProductionDefaults, 'imagePreprocess'>> & {
    imagePreprocess?: Partial<ProductionDefaults['imagePreprocess']>;
  }) | undefined = undefined,
): ProductionDefaults {
  const merged = {
    timeoutMs: value?.timeoutMs ?? BUILTIN_PRODUCTION_DEFAULTS.timeoutMs,
    projectConcurrency: value?.projectConcurrency ?? BUILTIN_PRODUCTION_DEFAULTS.projectConcurrency,
    videoConcurrency: value?.videoConcurrency ?? BUILTIN_PRODUCTION_DEFAULTS.videoConcurrency,
    imagePreprocess: {
      enabled: value?.imagePreprocess?.enabled ?? BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess.enabled,
      targetMaxSide: value?.imagePreprocess?.targetMaxSide ?? BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess.targetMaxSide,
      jpegQuality: value?.imagePreprocess?.jpegQuality ?? BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess.jpegQuality,
    },
  };
  if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs <= 0) {
    throw new Error('服务器生产默认超时必须为正整数毫秒');
  }
  for (const [label, number] of [
    ['项目并发', merged.projectConcurrency],
    ['视频并发', merged.videoConcurrency],
    ['图片最长边', merged.imagePreprocess.targetMaxSide],
    ['图片压缩质量', merged.imagePreprocess.jpegQuality],
  ] as const) {
    if (!Number.isInteger(number) || number <= 0) throw new Error(`服务器生产默认${label}必须为正整数`);
  }
  return merged;
}

/** Unknown outcomes keep billing evidence but stop consuming scheduling slots after this idle window. */
export const TEAM_UNKNOWN_CONCURRENCY_POLICY = Object.freeze({ idleMs: 3 * 60_000, sweepIntervalMs: 60_000 });
