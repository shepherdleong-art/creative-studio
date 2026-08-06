import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startWindows = fs.readFileSync(path.join(root, 'scripts', 'start-windows.ps1'), 'utf8');
const startStack = fs.readFileSync(path.join(root, 'scripts', 'start-stack.ps1'), 'utf8');
const installedLauncher = fs.readFileSync(path.join(root, 'installer', 'windows', 'launcher.cs'), 'utf8');
const installedStart = fs.readFileSync(path.join(root, 'installer', 'windows', 'start-installed.ps1'), 'utf8');
const installedSidecar = fs.readFileSync(path.join(root, 'installer', 'windows', 'start-company-sidecar.ps1'), 'utf8');
const installedRestart = fs.readFileSync(path.join(root, 'installer', 'windows', 'restart-company-sidecar.ps1'), 'utf8');
const configExample = fs.readFileSync(path.join(root, 'litellm-config.example.yaml'), 'utf8');
const healthRoute = fs.readFileSync(path.join(root, 'app', 'api', 'company-provider', 'health', 'route.ts'), 'utf8');
const runtimeComponent = fs.readFileSync(path.join(root, 'components', 'company-provider', 'CompanyProviderRuntimeStatus.tsx'), 'utf8');

test('Windows 启动器把公司 sidecar 失败降级为警告并继续启动工作台', () => {
  const companyBlockStart = startWindows.indexOf('# ── 公司网关联动');
  const installBlockStart = startWindows.indexOf('if ($needsInstall)');
  const appBlockStart = startWindows.indexOf('$url =', companyBlockStart);
  assert.ok(companyBlockStart >= 0, '缺少公司网关联动区块');
  assert.ok(installBlockStart >= 0 && installBlockStart < companyBlockStart, '依赖安装必须先于 sidecar 启动');
  assert.ok(appBlockStart > companyBlockStart, '公司网关联动区块位置异常');
  const companyBlock = startWindows.slice(companyBlockStart, appBlockStart);

  assert.match(companyBlock, /start-stack\.ps1'\)/);
  assert.match(companyBlock, /公司网关组件启动失败，继续启动工作台/);
  assert.doesNotMatch(companyBlock, /exit\s+1/);
  assert.match(companyBlock, /公司网关状态文件缺失，正在清理 sidecar 并继续启动工作台/);
  assert.match(companyBlock, /stop-stack\.ps1/);
  assert.doesNotMatch(companyBlock, /cloudflared|pinggy|trycloudflare/i);
  assert.match(companyBlock, /公司网关组件不完整，正在清理旧 sidecar 状态并继续启动工作台/);
  assert.match(startWindows, /npm\.cmd run dev/);
});

test('start-stack 在失败时清理本轮受控状态文件，避免残留 sidecar 状态', () => {
  assert.match(startStack, /\$stackFile\s*=\s*Join-Path\s+\$RunDir\s+'stack\.json'/);
  assert.match(startStack, /Remove-Item\s+\$stackFile[^\n]*-Force/);
  assert.match(startStack, /catch\s*\{[\s\S]*?Remove-Item\s+\$stackFile/);
  const portCheckStart = startStack.indexOf('# ── 端口占用检查');
  const staleCleanupStart = startStack.indexOf('# 只有端口确认空闲后才清理陈旧状态');
  assert.ok(portCheckStart >= 0 && staleCleanupStart > portCheckStart, '不能在端口预检前丢失旧 sidecar 状态');
});

test('-SkipApp 只要求公司 sidecar 文件，不把 standalone app 当成 sidecar 前置条件', () => {
  const requiredFilesStart = startStack.indexOf('$requiredFiles =');
  const portCheckStart = startStack.indexOf('# ── 端口占用检查', requiredFilesStart);
  assert.ok(requiredFilesStart >= 0, '缺少必需文件列表');
  assert.ok(portCheckStart > requiredFilesStart, '必需文件列表位置异常');
  const requiredFilesBlock = startStack.slice(requiredFilesStart, portCheckStart);
  assert.match(requiredFilesBlock, /\$litellmExe/);
  assert.doesNotMatch(requiredFilesBlock, /cloudflared/i);
  assert.match(requiredFilesBlock, /config\.yaml/);
  assert.match(requiredFilesBlock, /if \(-not \$SkipApp\)/);
  assert.match(requiredFilesBlock, /\$nodeExe/);
  assert.match(requiredFilesBlock, /standalone.*server\.js/);
});

test('启动脚本健康检查只使用本机 LiteLLM，并且状态文件不含认证密钥', () => {
  assert.match(startStack, /http:\/\/127\.0\.0\.1:\$ProxyPort\/health\/liveliness/);
  assert.match(startStack, /startedAt/);
  assert.doesNotMatch(startStack, /started\.(?:apiKey|masterKey)|started\[['"](?:apiKey|masterKey)['"]\]/);
});

test('公司健康 API 从 dataRoot 读取并明确禁止缓存', () => {
  assert.match(healthRoute, /inspectCompanyProviderRuntime\(\{ root: dataRoot\(\) \}\)/);
  assert.match(healthRoute, /Cache-Control.*no-store/);
  assert.doesNotMatch(healthRoute, /process\.cwd\(\)/);
});

test('设置页状态刷新使用请求序号与卸载守卫，旧响应不能覆盖新结果', () => {
  assert.match(runtimeComponent, /requestIdRef/);
  assert.match(runtimeComponent, /mountedRef/);
  assert.match(runtimeComponent, /requestId === requestIdRef\.current/);
  assert.equal((runtimeComponent.match(/\/api\/company-provider\/health/g) ?? []).length, 1);
});

test('LiteLLM 配置模板名称与一键启动脚本一致', () => {
  assert.match(configExample, /复制为 config\.yaml/);
  assert.match(startStack, /'config\.yaml'/);
});

test('已安装布局才开启受管信号并自动 ensure sidecar，开发布局保持 unrestricted', () => {
  assert.match(installedLauncher, /bool\s+isInstalled/);
  assert.match(installedLauncher, /DetectLayout\([^\n]*isInstalled/);
  assert.match(installedLauncher, /isInstalled\s*\?\s*StartCompanySidecar|if\s*\(isInstalled\)[\s\S]*StartCompanySidecar/);
  assert.match(installedLauncher, /CREATIVE_STUDIO_MANAGED_DEPLOYMENT.*1/);
  assert.doesNotMatch(installedLauncher, /CREATIVE_STUDIO_PROXY_PORT/);
  assert.doesNotMatch(installedLauncher, /optional|offline/i);
  assert.match(installedStart, /CREATIVE_STUDIO_DATA_ROOT/);
  assert.match(installedStart, /CREATIVE_STUDIO_MANAGED_DEPLOYMENT/);
});

test('受管 sidecar 固定以 UTF-8、127.0.0.1:4000 启动并发布窄状态', () => {
  assert.match(installedSidecar, /\$sidecarArguments\s*=\s*@\(/);
  for (const token of ['-X', 'utf8', '-m', 'litellm.proxy.proxy_cli', '--host', '127.0.0.1', '--port', '4000', '--num_workers', '1', '--config', '--telemetry', 'false']) {
    assert.match(installedSidecar, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(installedSidecar, /PYTHONUTF8/);
  assert.match(installedSidecar, /PYTHONIOENCODING/);
  assert.match(installedSidecar, /LITELLM_LOCAL_MODEL_COST_MAP/);
  assert.match(installedSidecar, /schemaVersion\s*=\s*2/);
  assert.match(installedSidecar, /company-sidecar-status\.json/);
  assert.match(installedSidecar, /requestId/);
  assert.match(installedSidecar, /company-sidecar-start\.lock/);
  assert.match(installedSidecar, /provisioning state.*schema.*2|schemaVersion.*2/i);
  assert.match(installedSidecar, /health\/liveliness/);
  assert.match(installedSidecar, /StatusCode\)\s*-eq\s*200|StatusCode\s*-eq\s*200/);
  assert.match(installedRestart, /stop-company-sidecar\.ps1/);
  assert.match(installedRestart, /start-company-sidecar\.ps1/);
});
