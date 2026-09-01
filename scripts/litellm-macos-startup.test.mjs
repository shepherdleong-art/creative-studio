import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('macOS 公司供应商运行环境只把 LiteLLM 绑定到 loopback', () => {
  const startLiteLlm = read('scripts/start-litellm.sh');

  assert.match(startLiteLlm, /\.venv-litellm\/bin\/litellm/);
  assert.match(startLiteLlm, /--host[\s\\\n]+127\.0\.0\.1/);
  assert.doesNotMatch(startLiteLlm, /0\.0\.0\.0/);
  assert.match(startLiteLlm, /http:\/\/127\.0\.0\.1:\$proxy_port\/health\/liveliness/);
  assert.match(startLiteLlm, /litellmPid/);
  assert.match(startLiteLlm, /stopScript/);
  assert.doesNotMatch(startLiteLlm, /apiKey|masterKey/);
});

test('macOS LiteLLM 子进程不继承 Codex 或终端的上游代理', () => {
  const startLiteLlm = read('scripts/start-litellm.sh');
  const launchStart = startLiteLlm.indexOf('env \\\n');
  const launchEnd = startLiteLlm.indexOf('litellm_pid=$!');

  assert.notEqual(launchStart, -1, 'LiteLLM 必须通过受控 env 启动');
  assert.ok(launchEnd > launchStart, 'LiteLLM 代理隔离必须与启动命令位于同一命令块');

  const launchBlock = startLiteLlm.slice(launchStart, launchEnd);
  for (const proxyVariable of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    assert.match(
      launchBlock,
      new RegExp(`-u\\s+${proxyVariable}\\b`),
      `LiteLLM 启动前必须清除 ${proxyVariable}`,
    );
  }
  assert.match(launchBlock, /"\$litellm_exe"/);
});

test('macOS 工作台启动和停止入口共同看管 LiteLLM sidecar', () => {
  const startCommand = read('start.command');
  const startDesktopCommand = read('start-desktop.command');
  const stopCommand = read('stop.command');

  assert.match(startCommand, /scripts\/start-litellm\.sh/);
  assert.match(startCommand, /scripts\/stop-litellm\.sh/);
  assert.match(startCommand, /trap[\s\S]*cleanup/);
  // 桌面版入口和网页版入口是并列的两个启动路径，sidecar 看管方式必须一致。
  assert.match(startDesktopCommand, /scripts\/start-litellm\.sh/);
  assert.match(startDesktopCommand, /scripts\/stop-litellm\.sh/);
  assert.match(startDesktopCommand, /trap[\s\S]*cleanup/);
  assert.match(stopCommand, /scripts\/stop-litellm\.sh/);
});

test('macOS 源码启动的 Next dev 仅绑定 loopback', () => {
  const startCommand = read('start.command');

  assert.match(startCommand, /npm run dev -- --hostname 127\.0\.0\.1/);
  assert.doesNotMatch(startCommand, /--hostname\s+0\.0\.0\.0/);
});

test('LiteLLM 日志和状态文件跟随自定义 CREATIVE_STUDIO_DATA_ROOT', () => {
  const startLiteLlm = read('scripts/start-litellm.sh');
  const stopLiteLlm = read('scripts/stop-litellm.sh');

  assert.match(startLiteLlm, /data_root="\$\{CREATIVE_STUDIO_DATA_ROOT:-\$project_root\}"/);
  assert.match(startLiteLlm, /log_dir="\$data_root\/storage\/logs"/);
  assert.match(startLiteLlm, /run_dir="\$data_root\/storage\/run"/);
  assert.match(startLiteLlm, /stack_file="\$run_dir\/stack\.json"/);
  assert.match(stopLiteLlm, /data_root="\$\{CREATIVE_STUDIO_DATA_ROOT:-\$project_root\}"/);
  assert.match(stopLiteLlm, /stack_file="\$data_root\/storage\/run\/stack\.json"/);
});

test('UI 关闭端点按平台执行受控的 PowerShell 或 shell 停止脚本', () => {
  const shutdown = read('lib/shutdown.ts');

  assert.match(shutdown, /process\.platform === 'win32'/);
  assert.match(shutdown, /powershell\.exe/);
  assert.match(shutdown, /\/bin\/bash/);
  assert.match(shutdown, /stop-litellm\.sh/);
  assert.match(shutdown, /path\.resolve\(process\.cwd\(\), 'scripts'\)/);
});

test('LiteLLM 运行依赖锁定到已验证版本并包含 SOCKS 支持', () => {
  const requirements = read('requirements-litellm.txt');
  const eslintConfig = read('eslint.config.mjs');
  const nextConfig = read('next.config.ts');
  const standaloneSync = read('scripts/sync-standalone-assets.mjs');

  assert.match(requirements, /^litellm\[proxy\]==1\.89\.2$/m);
  assert.match(requirements, /^socksio==1\.0\.0$/m);
  assert.match(eslintConfig, /["']\.venv-litellm\/\*\*["']/);
  assert.match(nextConfig, /["']\.\/\.venv-litellm\/\*\*\/\*["']/);
  assert.match(nextConfig, /["']\.\/config\.yaml["']/);
  assert.match(standaloneSync, /config\.yaml/);
  assert.match(standaloneSync, /\.venv-litellm/);
});

test('LiteLLM Router 在应用超时前终止上游且不做内部重试', {
  skip: !fs.existsSync(path.join(root, 'config.yaml')),
}, () => {
  const config = read('config.yaml').replace(/\r/g, '');
  const routerBlock = config.match(/^router_settings:\n((?:^[ \t]+.*\n?)*)/m)?.[1] || '';

  assert.match(routerBlock, /^  num_retries: 0$/m, '公司模型请求不得在 LiteLLM 内部静默重试');
  assert.match(routerBlock, /^  timeout: 110$/m, '代理上游超时必须早于应用侧 120 秒超时');
  assert.doesNotMatch(config, /^num_retries:/m, '顶层 num_retries 不会传给 Router，禁止伪配置');
  assert.doesNotMatch(config, /^timeout:/m, '顶层 timeout 不会传给 Router，禁止伪配置');
});
