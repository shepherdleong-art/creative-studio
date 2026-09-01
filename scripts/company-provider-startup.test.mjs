import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startWindows = fs.readFileSync(path.join(root, 'scripts', 'start-windows.ps1'), 'utf8');
const startStack = fs.readFileSync(path.join(root, 'scripts', 'start-stack.ps1'), 'utf8');
const startDesktop = fs.readFileSync(path.join(root, 'scripts', 'start-desktop-windows.ps1'), 'utf8');
const stopStack = fs.readFileSync(path.join(root, 'scripts', 'stop-stack.ps1'), 'utf8');
const portableCmdPath = path.join(root, 'installer', 'windows', 'start-windows-portable.cmd');
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

test('LiteLLM 启动参数明确绑定 loopback，不能回归到公网监听', () => {
  const loopbackBindings = startStack.match(/'--host',\s*'127\.0\.0\.1'/g) ?? [];
  assert.ok(loopbackBindings.length >= 2, 'venv 与免安装两个分支都必须固定 --host 127.0.0.1');
  assert.match(startStack, /\$p = Start-Process -FilePath \$litellmExe/);
  assert.doesNotMatch(startStack, /0\.0\.0\.0/);
});

test('LiteLLM 子进程启动前剥离六个代理变量，且只影响子进程（不清洗父 shell / Next）', () => {
  const launchStart = startStack.indexOf('$env:LITELLM_LOCAL_MODEL_COST_MAP');
  const healthLoopStart = startStack.indexOf('$ok = $false', launchStart);
  assert.ok(launchStart >= 0 && healthLoopStart > launchStart, '缺少 LiteLLM 启动区块');
  const launchBlock = startStack.slice(launchStart, healthLoopStart);

  for (const proxyVariable of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy',
  ]) {
    assert.ok(launchBlock.includes(`'${proxyVariable}'`), `LiteLLM 启动前必须剥离 ${proxyVariable}`);
  }
  const saveCall = "$savedProxyValues[$name] = [System.Environment]::GetEnvironmentVariable($name, 'Process')";
  const stripCall = "[System.Environment]::SetEnvironmentVariable($name, $null, 'Process')";
  const spawnCall = 'Start-Process -FilePath $litellmExe';
  const restoreCall = "[System.Environment]::SetEnvironmentVariable($name, $savedProxyValues[$name], 'Process')";
  const saveIdx = launchBlock.indexOf(saveCall);
  const stripIdx = launchBlock.indexOf(stripCall);
  const spawnIdx = launchBlock.indexOf(spawnCall);
  const finallyIdx = launchBlock.indexOf('finally');
  const restoreIdx = launchBlock.lastIndexOf(restoreCall);
  assert.ok(saveIdx >= 0, '剥离前必须保存原值用于恢复');
  assert.ok(stripIdx > saveIdx, '必须先保存再剥离代理变量');
  assert.ok(spawnIdx > stripIdx, '代理变量剥离必须先于 LiteLLM 子进程启动');
  assert.ok(finallyIdx > spawnIdx && restoreIdx > finallyIdx, '恢复逻辑必须位于 finally 块，Start-Process 失败也不能弄丢调用方代理配置');
  // 代理隔离只能作用于 LiteLLM 子进程；app（Next）仍按调用方环境继承
  const appStart = startStack.indexOf('# ── 2. 启动 app');
  assert.ok(appStart > launchStart, '缺少 app 启动区块');
  assert.ok(!startStack.slice(appStart).includes(stripCall), '不得清洗 app 继承的代理变量');
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

// ======================================================================
// 工作流 B 任务 B3/B4：Windows 免安装模式（-Portable）合同与行为测试
// 免安装包固定契约：只使用包内 python-runtime，损坏即报包不完整，
// 不删除、不联网修复、不回退 .venv-litellm 或系统 Python。
// ======================================================================

test('免安装启动包装器固定 3 行并显式传递 -Portable（即使 manifest 缺失也不降级）', () => {
  assert.ok(fs.existsSync(portableCmdPath), '缺少 installer/windows/start-windows-portable.cmd');
  const text = fs.readFileSync(portableCmdPath, 'utf8');
  assert.ok(text.includes('\r\n'), 'start-windows-portable.cmd 必须使用 CRLF 行尾');
  assert.ok(!/(?<!\r)\n/.test(text), 'start-windows-portable.cmd 不得混入裸 LF');
  assert.equal(
    text.trim(),
    'cd /d "%~dp0"\r\n'
      + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\start-desktop-windows.ps1" -Portable %*\r\n'
      + 'exit /b %ERRORLEVEL%',
    '包装器必须固定调用 start-desktop-windows.ps1 -Portable（方案 §B4）',
  );
});

test('-Portable 在 start-desktop-windows.ps1 与 start-stack.ps1 之间逐层显式传递', () => {
  assert.match(startDesktop, /\[switch\]\$Portable/, 'start-desktop-windows.ps1 缺少 -Portable 参数');
  assert.match(startDesktop, /\$stackArgs \+= '-Portable'/, '免安装模式必须显式把 -Portable 传给 start-stack.ps1');
  assert.match(startStack, /\[switch\]\$Portable/, 'start-stack.ps1 缺少 -Portable 参数');
});

test('portable-manifest.json 完整性校验：schema、windows-portable-v1 模式与关键文件清单', () => {
  assert.match(startDesktop, /portable-manifest\.json/);
  assert.match(startDesktop, /windows-portable-v1/, '必须校验模式 windows-portable-v1');
  assert.match(startDesktop, /schemaVersion/, '必须校验 manifest schema 版本');
  for (const key of [
    'node-runtime/node.exe',
    'python-runtime/python.exe',
    'python-runtime/runtime-manifest.json',
    'scripts/start-litellm-proxy.py',
    'config.yaml',
  ]) {
    assert.ok(startDesktop.includes(`'${key}'`), `portable 关键文件清单缺少 ${key}`);
  }
  assert.match(startDesktop, /免安装包不完整，请重新复制/, 'manifest 缺失或损坏必须报告包损坏并提示重新复制');
});

test('免安装模式禁止联网修复：npm ci / Electron 下载 / Next 构建 / venv 重建 / pip 均被 -Portable 阻断', () => {
  // -Rebuild 在免安装模式必须直接拒绝
  assert.match(startDesktop, /if \(\$Portable -and \$Rebuild\)/, '免安装模式必须拒绝 -Rebuild');
  assert.match(startDesktop, /重新生成免安装包/, '拒绝 -Rebuild 时必须提示由发布者重新生成免安装包');

  // venv 重建 / pip / 系统 Python 只允许存在于 if (-not $Portable) 守卫内
  const venvGuard = startDesktop.indexOf('if (-not $Portable)');
  assert.ok(venvGuard >= 0, 'venv 修复逻辑必须整体包在 if (-not $Portable) 守卫内');
  const beforeGuard = startDesktop.slice(0, venvGuard);
  assert.doesNotMatch(beforeGuard, /-m venv|pip install|py -3\.12/, '免安装守卫之前不得出现 venv/pip/系统 Python 修复');
  assert.match(startDesktop.slice(venvGuard), /-m venv/, '源码态 venv 重建逻辑必须保留在守卫内');

  // 载荷缺失时，免安装模式直接报错退出，不得进入联网修复分支
  for (const [label, anchor] of [
    ['npm ci', '& npm.cmd ci'],
    ['Electron 运行时下载', '& $nodeExe $electronInstall'],
    ['Next standalone 构建', '& npm.cmd run build'],
    ['桌面壳编译', '& npm.cmd run build:desktop'],
  ]) {
    const branchIdx = startDesktop.indexOf(anchor);
    assert.ok(branchIdx >= 0, `缺少既有分支：${label}`);
    const guardIdx = startDesktop.lastIndexOf('if ($Portable)', branchIdx);
    assert.ok(guardIdx >= 0, `${label} 分支前必须有 if ($Portable) 拦截`);
    const guarded = startDesktop.slice(guardIdx, branchIdx);
    const exitIdx = guarded.indexOf('exit 1');
    assert.ok(exitIdx >= 0, `免安装模式在 ${label} 前必须直接退出`);
    assert.match(guarded.slice(0, exitIdx), /免安装包/, `免安装模式在 ${label} 前必须提示重新复制免安装包`);
    // exit 1 必须出现在任何联网修复调用（Assert-NpmAvailable / npm）之前
    const npmIdx = guarded.search(/Assert-NpmAvailable|npm\.cmd/);
    assert.ok(npmIdx === -1 || exitIdx < npmIdx, `免安装模式必须在进入 ${label} 联网分支前退出`);
  }
});

test('未传 -Portable 的源码态保留既有 venv 修复与启动流程', () => {
  assert.match(
    startDesktop,
    /\$hasStackComponents = \(Test-Path \(Join-Path \$Root '\.venv-litellm\\Scripts\\litellm\.exe'\)\)/,
    '非免安装模式公司组件检测必须保留 .venv-litellm',
  );
  assert.match(startDesktop, /检测到 LiteLLM 环境已失效/, '源码态 venv 失效自动重建分支必须保留');
});

test('start-stack.ps1 免安装模式 runtime 优先、固定 loopback，损坏时不删除不联网不回退', () => {
  const branchStart = startStack.indexOf('if ($Portable) {');
  assert.ok(branchStart >= 0, 'start-stack.ps1 缺少免安装分支');
  const branchEnd = startStack.indexOf('$requiredFiles =', branchStart);
  assert.ok(branchEnd > branchStart, '免安装分支必须位于必需文件检查之前');
  const branch = startStack.slice(branchStart, branchEnd);

  assert.match(branch, /python-runtime\\python\.exe/, '免安装模式必须使用包内 python-runtime');
  assert.match(branch, /runtime-manifest\.json/, '必须校验 runtime-manifest.json');
  assert.match(branch, /'3\.12\.10'/, '必须校验 Python 3.12.10');
  assert.match(branch, /'1\.89\.2'/, '必须校验 LiteLLM 1.89.2');
  assert.match(branch, /Get-FileHash/, '必须按 manifest 记录校验关键文件哈希');
  assert.match(branch, /start-litellm-proxy\.py/, '必须经 start-litellm-proxy.py 入口启动');
  assert.match(branch, /'--host',\s*'127\.0\.0\.1'/, '免安装模式必须固定监听 127.0.0.1');
  assert.match(branch, /免安装包不完整，请重新复制/, 'runtime 缺失/损坏必须提示重新复制');
  assert.match(branch, /exit 1/, 'runtime 校验失败必须退出 sidecar 启动');
  assert.doesNotMatch(
    branch,
    /\.venv-litellm|py -3\.12|-m venv|pip\s|Invoke-WebRequest|winget/i,
    '免安装分支不得回退 venv/系统 Python，不得联网修复',
  );

  // start-stack 在任何模式下都不得自建 venv 或回退系统 Python
  assert.doesNotMatch(startStack, /-m venv/, 'start-stack.ps1 不得自建 venv');
  assert.doesNotMatch(startStack, /py -3\.12/, 'start-stack.ps1 不得回退系统 Python');
  // 非免安装模式维持 .venv-litellm 现状
  assert.match(startStack, /\.venv-litellm\\Scripts\\litellm\.exe/);
});

test('stack.json 记录运行时种类与实际解释器路径，且不包含密钥', () => {
  assert.match(startStack, /\$started\.litellmRuntime\s*=/, 'stack.json 必须记录运行时种类');
  assert.match(startStack, /\$started\.litellmInterpreter\s*=/, 'stack.json 必须记录实际解释器路径');
  assert.match(startStack, /'python-runtime'/, '运行时种类必须能区分 python-runtime');
  assert.match(startStack, /'venv-litellm'/, '运行时种类必须能区分 venv-litellm');
  assert.doesNotMatch(startStack, /started\.(?:apiKey|masterKey|secret)/i, 'stack.json 不得记录密钥');
});

test('stop-stack.ps1 按 stack.json PID 停止并校验可执行路径归属，不误杀未知端口进程', () => {
  assert.match(stopStack, /litellmPid/, '必须优先按状态文件 PID 停止');
  assert.match(stopStack, /ExecutablePath/, '必须校验进程可执行路径');
  assert.match(stopStack, /python-runtime/, '允许路径必须包含本项目 python-runtime');
  assert.match(stopStack, /\.venv-litellm/, '允许路径必须包含本项目 .venv-litellm');
  const portFallback = stopStack.slice(stopStack.indexOf('Get-NetTCPConnection'));
  assert.match(portFallback, /Test-OwnedProcess|ExecutablePath/, '端口属主兜底必须过滤非本项目进程');
  assert.match(stopStack, /不属于本项目/, '遇到不属于本项目的进程必须明示跳过');
});

test('start-windows.ps1 公司组件检测同时识别内置 runtime 与 venv', () => {
  assert.match(startWindows, /python-runtime\\python\.exe/, '开发入口必须识别内置 python-runtime');
  assert.match(startWindows, /\.venv-litellm\\Scripts\\litellm\.exe/, '开发入口必须继续识别 .venv-litellm');
});

// ── 行为测试：真实执行 PowerShell 脚本（仅 Windows），验证 -Portable 不进入任何联网修复分支 ──
const isWindows = process.platform === 'win32';

function makePortableFixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-fixture-'));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const name of ['start-desktop-windows.ps1', 'start-stack.ps1', 'stop-stack.ps1']) {
    fs.copyFileSync(path.join(root, 'scripts', name), path.join(dir, 'scripts', name));
  }
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function runPs1(scriptPath, args, input) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { input, encoding: 'utf8', timeout: 120000, windowsHide: true },
  );
}

test('B4 行为：-Portable 且 manifest 缺失时报包损坏并安全失败，不创建 node_modules、不执行 npm', { skip: !isWindows }, (t) => {
  const dir = makePortableFixture(t);
  const r = runPs1(path.join(dir, 'scripts', 'start-desktop-windows.ps1'), ['-Portable'], 'n\n');
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.status, 1, `manifest 缺失且载荷缺失时应安全失败退出：\n${out}`);
  assert.match(out, /免安装包不完整，请重新复制/, '必须报告包损坏');
  assert.match(out, /免安装模式不执行 npm/, '缺 node_modules 时必须提示而非联网安装');
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), '免安装模式不得创建 node_modules');
});

test('B4 行为：-Portable 且 manifest 缺失但应用载荷完整时不启动 sidecar、不降级源码分支', { skip: !isWindows }, (t) => {
  const dir = makePortableFixture(t, {
    'node_modules/.bin/electron.cmd': '@exit /b 0\r\n',
    'node_modules/electron/dist/electron.exe': '',
    '.next/standalone/server.js': '',
    '.next/standalone/runtime/server-entry.js': '',
    'dist-desktop/main.js': '',
  });
  fs.mkdirSync(path.join(dir, 'desktop'), { recursive: true });
  const r = runPs1(path.join(dir, 'scripts', 'start-desktop-windows.ps1'), ['-Portable'], 'y\n');
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.status, 0, `载荷完整时工作台应继续启动：\n${out}`);
  assert.match(out, /免安装包不完整，请重新复制/, 'manifest 缺失必须报告包损坏');
  assert.doesNotMatch(out, /正在安装依赖|npm\.cmd|正在重新构建|正在编译桌面壳/, '不得进入任何 npm/构建分支');
  assert.ok(
    !fs.existsSync(path.join(dir, 'storage', 'run', 'stack.json')),
    'manifest 无效时不得启动 sidecar（不得写 stack.json）',
  );
});

test('B4 行为：-Portable 收到 -Rebuild 必须拒绝，不进入构建分支', { skip: !isWindows }, (t) => {
  const dir = makePortableFixture(t);
  const r = runPs1(path.join(dir, 'scripts', 'start-desktop-windows.ps1'), ['-Portable', '-Rebuild'], 'n\n');
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.status, 1, `-Portable -Rebuild 必须拒绝：\n${out}`);
  assert.match(out, /重新生成免安装包/);
  assert.doesNotMatch(out, /npm\.cmd|正在重新构建/);
});

test('B3 行为：start-stack.ps1 -Portable 在 runtime 缺失时报包损坏、不写 stack.json、不起进程', { skip: !isWindows }, (t) => {
  const dir = makePortableFixture(t);
  const r = runPs1(
    path.join(dir, 'scripts', 'start-stack.ps1'),
    ['-Portable', '-SkipApp', '-ProxyPort', '4123'],
    '',
  );
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.equal(r.status, 1, `runtime 缺失时必须失败：\n${out}`);
  assert.match(out, /免安装包不完整，请重新复制/);
  assert.ok(!fs.existsSync(path.join(dir, 'storage', 'run', 'stack.json')), '校验失败不得写 stack.json');
});
