import fs from 'node:fs';
import path from 'node:path';
import { normalizeProductionDefaults, type ProductionDefaults } from './production-defaults.ts';

export type RuntimeEnvironment = Record<string, string | undefined>;

export type RuntimeConfig =
  | { mode: 'local' }
  | {
      mode: 'server';
      dataRoot: string;
      hostname: '127.0.0.1';
      port: number;
      deploymentId: string;
      trustedOrigin: string;
      /**
       * 服务器统一管理的生产参数默认值（06 号票）。
       *
       * 首版没有修改界面：这里给的是「起步默认值 = 改动前客户端的默认值」。
       * 想要换值时改 `production-defaults.ts` 的 `BUILTIN_PRODUCTION_DEFAULTS`；
       * server 模式下新建项目、提交图片/视频任务一律取这份，忽略请求里的同名字段。
       *
       * 可选是为了让守护测试可以只构造必要字段；真实入口（`readRuntimeConfig`）
       * 总会填上，缺省时裁决函数回退到同一套起步默认值。
       */
      productionDefaults?: ProductionDefaults;
    };

export type ServerRuntimeConfig = Extract<RuntimeConfig, { mode: 'server' }>;

interface DeploymentMarker {
  version: 1;
  mode: 'server';
  deploymentId: string;
}

function required(env: RuntimeEnvironment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`server 模式必须显式配置 ${key}`);
  return value;
}

/**
 * 服务器默认生产参数的运维覆盖（06 号票）。
 *
 * 「首版不做修改界面」不等于写死：部署方要调默认超时/并发/预处理时改这几个环境变量，
 * 与 `CREATIVE_STUDIO_*` 其他运行配置同一层。缺省 = 改动前客户端默认值。
 * 解析失败按启动配置错误处理（早失败），不会把 0 并发带进队列。
 */
function productionDefaultsFromEnv(env: RuntimeEnvironment): ProductionDefaults {
  const optionalNumber = (key: string): number | undefined => {
    const text = env[key]?.trim();
    if (!text) return undefined;
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error(`${key} 必须是数字`);
    return parsed;
  };
  const enabledText = env.CREATIVE_STUDIO_PRODUCTION_IMAGE_PREPROCESS_ENABLED?.trim().toLowerCase();
  if (enabledText && !['true', 'false', '1', '0'].includes(enabledText)) {
    throw new Error('CREATIVE_STUDIO_PRODUCTION_IMAGE_PREPROCESS_ENABLED 只支持 true/false');
  }
  return normalizeProductionDefaults({
    timeoutMs: optionalNumber('CREATIVE_STUDIO_PRODUCTION_TIMEOUT_MS'),
    projectConcurrency: optionalNumber('CREATIVE_STUDIO_PRODUCTION_PROJECT_CONCURRENCY'),
    videoConcurrency: optionalNumber('CREATIVE_STUDIO_PRODUCTION_VIDEO_CONCURRENCY'),
    imagePreprocess: {
      enabled: enabledText ? enabledText === 'true' || enabledText === '1' : undefined,
      targetMaxSide: optionalNumber('CREATIVE_STUDIO_PRODUCTION_IMAGE_MAX_SIDE'),
      jpegQuality: optionalNumber('CREATIVE_STUDIO_PRODUCTION_IMAGE_JPEG_QUALITY'),
    },
  });
}

export function readRuntimeConfig(env: RuntimeEnvironment = process.env): RuntimeConfig {
  const mode = env.CREATIVE_STUDIO_DEPLOYMENT_MODE?.trim() || 'local';
  if (mode === 'local') return { mode: 'local' };
  if (mode !== 'server') {
    throw new Error('CREATIVE_STUDIO_DEPLOYMENT_MODE 只支持 local 或 server');
  }

  const dataRoot = path.resolve(required(env, 'CREATIVE_STUDIO_DATA_ROOT'));
  const portText = required(env, 'CREATIVE_STUDIO_PORT');
  const port = Number(portText);
  if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('CREATIVE_STUDIO_PORT 必须是 1–65535 的固定端口');
  }
  const deploymentId = required(env, 'CREATIVE_STUDIO_DEPLOYMENT_ID');
  const originText = required(env, 'CREATIVE_STUDIO_TRUSTED_ORIGIN');
  let trustedOrigin: string;
  try {
    const origin = new URL(originText);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) {
      throw new Error('unsupported origin');
    }
    trustedOrigin = origin.origin;
  } catch {
    throw new Error('CREATIVE_STUDIO_TRUSTED_ORIGIN 必须是有效的 HTTP(S) origin');
  }

  return {
    mode: 'server',
    dataRoot,
    hostname: '127.0.0.1',
    port,
    deploymentId,
    trustedOrigin,
    productionDefaults: productionDefaultsFromEnv(env),
  };
}

export function deploymentMarkerPath(root: string): string {
  return path.join(root, 'data', 'deployment.json');
}

function readDeploymentMarker(root: string): DeploymentMarker | null {
  const markerPath = deploymentMarkerPath(root);
  if (!fs.existsSync(markerPath)) return null;
  let marker: Partial<DeploymentMarker>;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Partial<DeploymentMarker>;
  } catch {
    throw new Error('数据根部署标识无法读取，已拒绝打开业务数据库');
  }
  if (marker.version !== 1 || marker.mode !== 'server' || !marker.deploymentId?.trim()) {
    throw new Error('数据根部署标识无效，已拒绝打开业务数据库');
  }
  return marker as DeploymentMarker;
}

export function assertDeploymentDataRootAccess(
  root: string,
  config: RuntimeConfig,
): void {
  const marker = readDeploymentMarker(root);
  if (config.mode === 'local') {
    if (marker?.mode === 'server') {
      throw new Error('本地模式不得打开 server 数据根；请使用独立团队服务入口');
    }
    return;
  }
  if (path.resolve(config.dataRoot) !== path.resolve(root)) {
    throw new Error('server 配置数据根与当前业务数据根不一致');
  }
  if (!marker) {
    throw new Error('server 数据根尚未写入部署标识，已拒绝打开业务数据库');
  }
  if (marker.deploymentId !== config.deploymentId) {
    throw new Error('server 部署 ID 与数据根标识不一致');
  }
}

export function ensureServerDeploymentMarker(config: ServerRuntimeConfig): void {
  const markerPath = deploymentMarkerPath(config.dataRoot);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  const marker: DeploymentMarker = {
    version: 1,
    mode: 'server',
    deploymentId: config.deploymentId,
  };
  try {
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  assertDeploymentDataRootAccess(config.dataRoot, config);
}
