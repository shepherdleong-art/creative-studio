/**
 * 服务器统一管理的生产参数（06 号票）——纯函数裁决。
 *
 * 四类情形（对应任务单验收）：
 *   1. server 模式忽略请求里的值，一律用服务器默认值；
 *   2. 服务器默认值改了以后，新裁决用新值；
 *   3. local 模式保留请求值（改动前语义）；
 *   4. 缺省字段回退到内置默认值。
 *
 * 另外钉住两件容易漂移的事：
 *   - 内置默认值必须等于改动前客户端的默认值（超时 600000ms、并发 10、视频并发 10、
 *     预处理开启、最长边/质量取自 `lib/image-preprocess.ts` 的 DEFAULT_OPTIONS）；
 *   - 非法服务器默认值必须早失败，不能把 0 并发带进队列。
 */
import assert from 'node:assert/strict';

const {
  BUILTIN_PRODUCTION_DEFAULTS,
  normalizeProductionDefaults,
  productionParamsFor,
  resolveProductionParams,
} = await import('../lib/team-service/production-defaults.ts');

const CLIENT_DEFAULTS = {
  timeoutMs: 600_000,
  projectConcurrency: 10,
  videoConcurrency: 10,
  imagePreprocess: { enabled: true, targetMaxSide: 1536, jpegQuality: 85 },
} as const;

// ── 起步默认值 = 改动前客户端默认值 ──
assert.deepEqual(BUILTIN_PRODUCTION_DEFAULTS, CLIENT_DEFAULTS, '内置默认值必须等于改动前客户端默认值');

// 图片预处理两个数值必须与 lib/image-preprocess.ts 的 DEFAULT_OPTIONS 一致。
// 单独动态导入它（会拉起 sharp），所以只在这个测试里读一次。
process.env.CREATIVE_STUDIO_SKIP_FONT_PROBE = '1';
const { DEFAULT_OPTIONS } = await import('../lib/image-preprocess.ts');
assert.equal(DEFAULT_OPTIONS.targetMaxSide, BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess.targetMaxSide,
  '服务器默认最长边必须与 lib/image-preprocess.ts DEFAULT_OPTIONS 一致');
assert.equal(DEFAULT_OPTIONS.jpegQuality, BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess.jpegQuality,
  '服务器默认压缩质量必须与 lib/image-preprocess.ts DEFAULT_OPTIONS 一致');
assert.equal(DEFAULT_OPTIONS.enabled, BUILTIN_PRODUCTION_DEFAULTS.imagePreprocess.enabled,
  '服务器默认预处理开关必须与 lib/image-preprocess.ts DEFAULT_OPTIONS 一致');

// ── 情形 1：server 忽略请求值 ──
assert.deepEqual(
  resolveProductionParams({
    mode: 'server',
    requested: {
      timeoutMs: 45_000,
      concurrency: 3,
      videoConcurrency: 2,
      preprocessEnabled: false,
      targetMaxSide: 4096,
      jpegQuality: 70,
    },
  }),
  CLIENT_DEFAULTS,
  'server 模式必须丢弃请求里的超时/并发/预处理，改用服务器默认值',
);

// 请求值是字符串（multipart form 的形态）也一样丢弃。
assert.deepEqual(
  resolveProductionParams({
    mode: 'server',
    requested: { timeoutMs: '1000', concurrency: '1', preprocessEnabled: 'false', targetMaxSide: '512', jpegQuality: '60' },
  }),
  CLIENT_DEFAULTS,
  '字符串形态的客户端参数同样必须被丢弃',
);

// ── 情形 2：改服务器默认值后生效 ──
const tuned = {
  timeoutMs: 900_000,
  projectConcurrency: 4,
  videoConcurrency: 3,
  imagePreprocess: { enabled: false, targetMaxSide: 2048, jpegQuality: 92 },
};
assert.deepEqual(
  resolveProductionParams({ mode: 'server', requested: { concurrency: 10, targetMaxSide: 1024 }, defaults: tuned }),
  tuned,
  '改过的服务器默认值必须原样生效，且仍忽略请求值',
);
assert.deepEqual(
  productionParamsFor({ mode: 'server', productionDefaults: tuned }, { timeoutMs: 1, concurrency: 9 }),
  tuned,
  'productionParamsFor 必须读运行时配置里的服务器默认值',
);

// 视频并发在两种模式下都钳制在 1–10（执行池本来就按这个上限工作）。
assert.equal(
  resolveProductionParams({ mode: 'server', defaults: { ...tuned, videoConcurrency: 99 } }).videoConcurrency,
  10,
  '服务器默认视频并发必须钳制到 10',
);
assert.equal(
  resolveProductionParams({ mode: 'server', defaults: { ...tuned, videoConcurrency: 0 } }).videoConcurrency,
  1,
  '服务器默认视频并发必须钳制到至少 1',
);

// ── 情形 3：local 保留请求值 ──
assert.deepEqual(
  resolveProductionParams({
    mode: 'local',
    requested: {
      timeoutMs: 45_000,
      concurrency: 3,
      videoConcurrency: 2,
      preprocessEnabled: false,
      targetMaxSide: 4096,
      jpegQuality: 70,
    },
  }),
  {
    timeoutMs: 45_000,
    projectConcurrency: 3,
    videoConcurrency: 2,
    imagePreprocess: { enabled: false, targetMaxSide: 4096, jpegQuality: 70 },
  },
  '本地版必须保留请求里的值',
);
assert.deepEqual(
  resolveProductionParams({ mode: 'local', requested: { concurrency: '3', preprocessEnabled: 'false' } }),
  {
    timeoutMs: 600_000,
    projectConcurrency: 3,
    videoConcurrency: 10,
    imagePreprocess: { enabled: false, targetMaxSide: 1536, jpegQuality: 85 },
  },
  '本地版字符串形态的请求值也要按数字/布尔解析',
);

// ── 情形 4：缺省回退 ──
assert.deepEqual(resolveProductionParams({ mode: 'local' }), CLIENT_DEFAULTS, '本地版缺省字段回退到内置默认值');
assert.deepEqual(
  resolveProductionParams({ mode: 'local', requested: { timeoutMs: 0, concurrency: -1, targetMaxSide: Number.NaN } }),
  CLIENT_DEFAULTS,
  '非法的请求值（0 / 负数 / NaN）必须回退到默认值，不能写进队列',
);
assert.deepEqual(
  productionParamsFor({ mode: 'server' }),
  CLIENT_DEFAULTS,
  'server 配置缺省 productionDefaults 时回退到同一套起步默认值',
);

// ── 服务器默认值校验：写错要早失败 ──
assert.deepEqual(normalizeProductionDefaults(undefined), CLIENT_DEFAULTS, '未配置时给予起步默认值');
assert.throws(() => normalizeProductionDefaults({ projectConcurrency: 0 }), /项目并发/, '0 并发必须被拒绝');
assert.throws(() => normalizeProductionDefaults({ timeoutMs: -1 }), /超时/, '负数超时必须被拒绝');
assert.throws(
  () => normalizeProductionDefaults({ imagePreprocess: { enabled: true, targetMaxSide: 0, jpegQuality: 85 } }),
  /最长边/,
  '0 最长边必须被拒绝',
);
assert.throws(
  () => normalizeProductionDefaults({ imagePreprocess: { enabled: true, targetMaxSide: 1536, jpegQuality: 0 } }),
  /压缩质量/,
  '0 压缩质量必须被拒绝',
);

console.log('production defaults tests passed');
