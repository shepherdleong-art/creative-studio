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
