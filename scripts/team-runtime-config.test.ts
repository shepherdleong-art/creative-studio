import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-config-'));
const previousEnv = { ...process.env };

try {
  process.env.CREATIVE_STUDIO_DATA_ROOT = root;
  const {
    ensureServerDeploymentMarker,
    readRuntimeConfig,
  } = await import('../lib/team-service/config.ts');

  assert.deepEqual(readRuntimeConfig({}), { mode: 'local' });
  assert.throws(
    () => readRuntimeConfig({ CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server' }),
    /CREATIVE_STUDIO_DATA_ROOT/,
    'server 缺省数据根时必须拒绝，不能回退到仓库根',
  );
  assert.throws(
    () => readRuntimeConfig({ CREATIVE_STUDIO_DEPLOYMENT_MODE: 'production' }),
    /DEPLOYMENT_MODE/,
  );

  const server = readRuntimeConfig({
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_PORT: '3300',
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-a',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
  });
  assert.deepEqual(server, {
    mode: 'server',
    dataRoot: path.resolve(root),
    hostname: '127.0.0.1',
    port: 3300,
    deploymentId: 'deployment-a',
    trustedOrigin: 'https://studio.example.test',
    // 06：服务器统一管理的生产参数默认值，起步值 = 改动前客户端默认值。
    productionDefaults: {
      timeoutMs: 600_000,
      projectConcurrency: 10,
      videoConcurrency: 10,
      imagePreprocess: { enabled: true, targetMaxSide: 1536, jpegQuality: 85 },
    },
  });
  if (server.mode !== 'server') throw new Error('必须解析为 server 配置');
  ensureServerDeploymentMarker(server);

  // 服务器默认值可由部署方用环境变量覆盖（首版不做界面，但运维要能调）。
  const tuned = readRuntimeConfig({
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_PORT: '3300',
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-a',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
    CREATIVE_STUDIO_PRODUCTION_TIMEOUT_MS: '900000',
    CREATIVE_STUDIO_PRODUCTION_PROJECT_CONCURRENCY: '4',
    CREATIVE_STUDIO_PRODUCTION_VIDEO_CONCURRENCY: '3',
    CREATIVE_STUDIO_PRODUCTION_IMAGE_PREPROCESS_ENABLED: 'false',
    CREATIVE_STUDIO_PRODUCTION_IMAGE_MAX_SIDE: '2048',
    CREATIVE_STUDIO_PRODUCTION_IMAGE_JPEG_QUALITY: '92',
  });
  assert.deepEqual(tuned.mode === 'server' ? tuned.productionDefaults : null, {
    timeoutMs: 900_000,
    projectConcurrency: 4,
    videoConcurrency: 3,
    imagePreprocess: { enabled: false, targetMaxSide: 2048, jpegQuality: 92 },
  }, '部署方环境变量必须能改服务器生产默认值');
  assert.throws(() => readRuntimeConfig({
    CREATIVE_STUDIO_DEPLOYMENT_MODE: 'server',
    CREATIVE_STUDIO_DATA_ROOT: root,
    CREATIVE_STUDIO_PORT: '3300',
    CREATIVE_STUDIO_DEPLOYMENT_ID: 'deployment-a',
    CREATIVE_STUDIO_TRUSTED_ORIGIN: 'https://studio.example.test',
    CREATIVE_STUDIO_PRODUCTION_PROJECT_CONCURRENCY: '0',
  }), /项目并发/, '0 并发必须当作启动配置错误');

  process.env.CREATIVE_STUDIO_DEPLOYMENT_MODE = 'local';
  const { getDb, closeDb } = await import('../lib/db.ts');
  assert.throws(
    () => getDb(),
    /server.*数据根|服务器.*数据根/,
    '本地入口不得打开已经标记为 server 的数据根',
  );
  assert.equal(
    fs.existsSync(path.join(root, 'data', 'workbench.db')),
    false,
    '模式守卫必须早于业务数据库创建',
  );

  fs.rmSync(path.join(root, 'data', 'deployment.json'));
  assert.ok(getDb(), '无服务器标识的旧本地数据根必须保持兼容');
  closeDb();

  console.log('team runtime config tests passed');
} finally {
  process.env = previousEnv;
  fs.rmSync(root, { recursive: true, force: true });
}
