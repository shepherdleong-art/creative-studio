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
  const stopCommand = read('stop.command');

  assert.match(startCommand, /scripts\/start-litellm\.sh/);
  assert.match(startCommand, /scripts\/stop-litellm\.sh/);
  assert.match(startCommand, /trap[\s\S]*cleanup/);
  assert.match(stopCommand, /scripts\/stop-litellm\.sh/);
});

test('UI 关闭端点按平台执行受控的 PowerShell 或 shell 停止脚本', () => {
  const shutdownRoute = read('app/api/shutdown/route.ts');

  assert.match(shutdownRoute, /process\.platform === 'win32'/);
  assert.match(shutdownRoute, /powershell\.exe/);
  assert.match(shutdownRoute, /\/bin\/bash/);
  assert.match(shutdownRoute, /stop-litellm\.sh/);
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
