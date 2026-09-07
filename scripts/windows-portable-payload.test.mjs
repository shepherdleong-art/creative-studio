/**
 * Windows 免安装包装配合同与行为测试（方案 §B5/§B9 任务 B5）。
 *
 * 静态合同：装配脚本白名单包含两套 runtime 与全部启动所需文件，且明确排除
 * .venv-litellm/、data/、storage/、outputs/、docs/、.git/、.cache/ 与安装器产物；
 * config.yaml、.env.local 是内网分发唯一明确允许的敏感例外（只复制、不读取、不打印）。
 *
 * 行为测试（仅 Windows）：用临时 fixture 目录真实执行装配脚本，验证成品内容、
 * portable-manifest.json（相对路径 + size + sha256）、拒绝覆盖与缺件失败。
 * 不触碰共享盘。
 *
 * 运行：node scripts/windows-portable-payload.test.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildScriptPath = path.join(root, 'scripts', 'build-windows-portable.ps1');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ======================================================================
// 静态合同测试
// ======================================================================
assert.ok(fs.existsSync(buildScriptPath), '缺少 scripts/build-windows-portable.ps1');
assert.match(packageJson.scripts['build:win-portable'] ?? '', /build-windows-portable\.ps1/);
const buildBytes = fs.readFileSync(buildScriptPath);
assert.deepEqual(
  [...buildBytes.subarray(0, 3)],
  [0xef, 0xbb, 0xbf],
  '装配脚本必须是 UTF-8 带 BOM（PS 5.1 按 ANSI 读无 BOM 中文会解析失败）',
);
const hasOnlyCrLf = (bytes) => bytes.every((byte, i) => byte !== 0x0a || (i > 0 && bytes[i - 1] === 0x0d));
assert.ok(hasOnlyCrLf(buildBytes), '装配脚本必须使用 CRLF 行尾');
const build = buildBytes.toString('utf8').slice(1);

// 白名单必须包含两套 runtime 与全部启动所需文件
for (const required of [
  "'node-runtime'",
  "'python-runtime'",
  "'node_modules'",
  '$desktopPayloadFiles',
  "'.next\\standalone'",
  '$runtimeScriptFiles',
  "'package.json'",
  "'config.yaml'",
  "'.env.local'",
  "'LICENSE'",
  "'stop-windows.cmd'",
  '环境自检.cmd',
  'start-windows-portable.cmd',
  '迁移旧版数据.cmd',
  '使用说明-portable.txt',
]) {
  assert.ok(build.includes(required), `装配白名单缺少 ${required}`);
}

// portable cmd 模板必须落为成品根 start-windows.cmd，使用说明落为成品根 使用说明.txt
assert.match(build, /Target = 'start-windows\.cmd'/, 'portable 启动模板必须装配为成品根 start-windows.cmd');
assert.match(build, /Target = '迁移旧版数据\.cmd'/, '数据迁移模板必须装配为成品根 迁移旧版数据.cmd');
assert.match(build, /Target = '使用说明\.txt'/, '使用说明必须装配为成品根 使用说明.txt');

for (const runtimeScript of [
  'start-desktop-windows.ps1',
  'start-stack.ps1',
  'stop-stack.ps1',
  'stop-windows.ps1',
  'start-litellm-proxy.py',
  'diagnose-local-env.mjs',
  'migrate-portable-data.ps1',
  'migrate-portable-data.mjs',
]) {
  assert.ok(build.includes(`'${runtimeScript}'`), `运行时脚本白名单缺少 ${runtimeScript}`);
}

// 明确排除本机状态与安装器产物
for (const forbidden of [
  "'.venv-litellm'",
  "'data'",
  "'storage'",
  "'outputs'",
  "'docs'",
  "'.git'",
  "'.cache'",
  "'dist'",
  "'installer'",
]) {
  assert.ok(build.includes(forbidden), `装配脚本必须显式排除 ${forbidden}`);
}
// 白名单目录/文件清单本身不得夹带禁止项
const dirsBlock = build.match(/\$whitelistDirs = @\(([\s\S]*?)\)\r?\n/);
const filesBlock = build.match(/\$whitelistFiles = @\(([\s\S]*?)\)\r?\n/);
assert.ok(dirsBlock && filesBlock, '必须存在显式白名单目录/文件清单');
for (const forbidden of ['.venv-litellm', 'data', 'storage', 'outputs', 'docs', '.git', '.cache', 'dist', 'installer', 'desktop']) {
  assert.ok(!dirsBlock[1].includes(`'${forbidden}'`), `白名单目录不得包含 ${forbidden}`);
  assert.ok(!filesBlock[1].includes(`'${forbidden}'`), `白名单文件不得包含 ${forbidden}`);
}

// manifest 契约：与 start-desktop-windows.ps1 预检一致；仅运行必需文件参与强校验。
// 使用说明仍需随包交付，但允许维护者补充联系人等文字，不得因此禁用公司网关。
assert.match(build, /schemaVersion = 1/, 'manifest schemaVersion 必须锁定 1');
assert.match(build, /'windows-portable-v1'/, 'manifest mode 必须锁定 windows-portable-v1');
assert.match(build, /Get-Sha256Hex/, 'manifest 必须记录 SHA-256');
assert.match(build, /size/, 'manifest 必须记录文件大小');
assert.match(build, /appVersion/, 'manifest 必须记录应用版本');
assert.match(build, /builtAt/, 'manifest 必须记录构建时间');
assert.match(build, /sourceCommit/, 'manifest 必须记录源码 commit');
const portablePrecheck = fs.readFileSync(path.join(root, 'scripts', 'start-desktop-windows.ps1'), 'utf8');
const manifestKeyFilesBlock = build.match(/\$manifestKeyFiles = @\(([\s\S]*?)\)\r?\n/);
const portableRequiredFilesBlock = portablePrecheck.match(/\$portableRequiredFiles = @\(([\s\S]*?)\)\r?\n/);
assert.ok(manifestKeyFilesBlock && portableRequiredFilesBlock, '必须存在 manifest 与启动预检关键文件清单');
assert.ok(!manifestKeyFilesBlock[1].includes("'使用说明.txt'"), '可编辑使用说明不得进入 manifest 强校验');
assert.ok(!portableRequiredFilesBlock[1].includes("'使用说明.txt'"), '可编辑使用说明不得阻断便携版启动');
assert.match(
  portablePrecheck,
  /if \(\$Portable\)[\s\S]*?\$env:CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER = '1'/,
  '免安装启动入口必须覆盖同事机器的同名环境变量，强制开启脚本调度器',
);
for (const key of [
  'node-runtime/node.exe',
  'node_modules/.bin/electron.cmd',
  'node_modules/electron/dist/electron.exe',
  '.next/standalone/server.js',
  '.next/standalone/runtime/server-entry.js',
  'python-runtime/python.exe',
  'python-runtime/runtime-manifest.json',
  'scripts/start-desktop-windows.ps1',
  'scripts/start-stack.ps1',
  'scripts/start-litellm-proxy.py',
  'config.yaml',
  '.env.local',
  'stop-windows.cmd',
  '迁移旧版数据.cmd',
]) {
  assert.ok(build.includes(`'${key}'`), `manifest 关键文件清单缺少 ${key}`);
  assert.ok(portablePrecheck.includes(`'${key}'`), `预检关键文件清单与装配 manifest 不一致：${key}`);
}

// 装配顺序与安全约束
assert.match(build, /verify-python-runtime-windows\.ps1/, '装配前必须运行 python-runtime 只读验收');
assert.match(build, /npm\.cmd ci --include=dev/, '正式装配必须从 package-lock 重新安装干净依赖');
assert.match(build, /npm\.cmd run build/, '正式装配前必须重新生成 Next standalone');
assert.match(build, /npm\.cmd run build:desktop/, '正式装配前必须重新编译 Electron 桌面壳');
assert.match(build, /\[switch\]\$SkipBuild/, '临时 fixture 测试必须能显式跳过构建，正式默认不能跳过');
for (const runtimeGuard of [
  'process.versions.node',
  'process.versions.modules',
  'process.platform',
  'process.arch',
  "new Database(':memory:')",
  "require('sharp')",
]) {
  assert.ok(build.includes(runtimeGuard), `正式装配缺少 Node/原生模块硬校验：${runtimeGuard}`);
}
assert.match(build, /verify-portable-payload\.mjs/, '发布前必须执行递归敏感文件与密钥泄漏扫描');
assert.ok(
  build.indexOf('verify-python-runtime-windows.ps1') < build.indexOf('Copy-Item'),
  '必须先验收 runtime 再复制装配',
);
assert.match(build, /拒绝覆盖/, '目标已存在时必须拒绝覆盖');
assert.match(build, /staging/, '必须使用同盘临时目录装配后再发布');
assert.match(build, /Move-Item -LiteralPath \$staging -Destination \$OutputPath/, '必须改名发布（同盘原子移动）');
assert.doesNotMatch(
  build,
  /Get-Content[^\r\n]*(config\.yaml|\.env\.local)|ConvertFrom-Json[^\r\n]*(config\.yaml|\.env\.local)/,
  '装配脚本不得读取 config.yaml / .env.local 内容',
);

console.log('windows-portable payload static contract tests passed');

// ======================================================================
// 行为测试：临时 fixture 真实执行装配（仅 Windows，不碰共享盘）
// ======================================================================
if (process.platform !== 'win32') {
  console.log('windows-portable payload behavior tests skipped (not Windows)');
  process.exit(0);
}

const cleanups = [];
function makeFixture({ omit = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-assembly-'));
  cleanups.push(dir);
  const write = (rel, content = 'fixture\n') => {
    const target = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  // 装配脚本本体 + 验收脚本替身（行为测试不重复跑真实 runtime 验收）
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(buildScriptPath, path.join(dir, 'scripts', 'build-windows-portable.ps1'));
  write('scripts/verify-python-runtime-windows.ps1', 'Write-Host "stub verify ok"\r\nexit 0\r\n');
  // 白名单来源（内容为假数据，config.yaml/.env.local 带哨兵值用于泄漏断言）
  write('node-runtime/node.exe');
  write('python-runtime/python.exe');
  write('python-runtime/runtime-manifest.json', '{"schemaVersion":1}\n');
  write('node_modules/.bin/electron.cmd');
  write('node_modules/electron/dist/electron.exe');
  write('.next/standalone/server.js');
  write('.next/standalone/runtime/server-entry.js');
  write('dist-desktop/main.js');
  write('dist-desktop/preload.js');
  write('dist-desktop/service.js');
  write('dist-desktop/ipc.js');
  write('dist-desktop/main.js.map', '{"sources":["../desktop/main.ts"]}\n');
  write('dist-desktop/stale.js', 'throw new Error("stale build output");\n');
  write('scripts/start-desktop-windows.ps1');
  write('scripts/start-stack.ps1');
  write('scripts/stop-stack.ps1');
  write('scripts/start-litellm-proxy.py');
  write('scripts/diagnose-local-env.mjs');
  write('scripts/stop-windows.ps1');
  write('scripts/migrate-portable-data.ps1');
  write('scripts/migrate-portable-data.mjs');
  write('scripts/verify-portable-payload.mjs', 'process.exit(0);\n');
  write('scripts/probe-do-not-package.ts', 'throw new Error("development-only");\n');
  write('package.json', '{"name":"creative-studio","version":"0.6.0","main":"dist-desktop/main.js"}\n');
  write('config.yaml', 'model_list: [] # SENTINEL_CONFIG_SECRET\n');
  write('.env.local', '```env\nCREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1\n```\n');
  write('LICENSE', 'GPL-3.0-only fixture\n');
  write('stop-windows.cmd', '@echo off\r\n');
  write('环境自检.cmd', '@echo off\r\n');
  fs.mkdirSync(path.join(dir, 'installer', 'windows'), { recursive: true });
  fs.copyFileSync(
    path.join(root, 'installer', 'windows', 'start-windows-portable.cmd'),
    path.join(dir, 'installer', 'windows', 'start-windows-portable.cmd'),
  );
  fs.copyFileSync(
    path.join(root, 'installer', 'windows', '迁移旧版数据.cmd'),
    path.join(dir, 'installer', 'windows', '迁移旧版数据.cmd'),
  );
  write('installer/windows/使用说明-portable.txt', '说明\r\n');
  // 不得进入成品的本机状态与开发产物
  write('.venv-litellm/Scripts/litellm.exe');
  write('data/workbench.db');
  write('storage/logs/x.log');
  write('outputs/x.md');
  write('docs/x.md');
  write('.git/config');
  write('.cache/bin');
  write('dist/windows/CreativeStudioSetup.exe');
  write('desktop/main.ts');
  for (const rel of omit) {
    fs.rmSync(path.join(dir, ...rel.split('/')), { recursive: true, force: true });
  }
  return dir;
}

function runAssembly(fixtureDir, outputPath) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(fixtureDir, 'scripts', 'build-windows-portable.ps1'),
      '-OutputPath',
      outputPath,
      '-SkipBuild',
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
}

try {
  // ── 正常装配 ──
  const fixture = makeFixture();
  const output = path.join(fixture, 'out', '创意工作台-免安装版');
  const run = runAssembly(fixture, output);
  assert.equal(run.status, 0, `装配失败：\n${run.stdout}\n${run.stderr}`);

  for (const expected of [
    'node-runtime/node.exe',
    'python-runtime/python.exe',
    'python-runtime/runtime-manifest.json',
    'node_modules/.bin/electron.cmd',
    'node_modules/electron/dist/electron.exe',
    '.next/standalone/server.js',
    '.next/standalone/runtime/server-entry.js',
    'dist-desktop/main.js',
    'dist-desktop/preload.js',
    'dist-desktop/service.js',
    'dist-desktop/ipc.js',
    'scripts/start-desktop-windows.ps1',
    'scripts/start-stack.ps1',
    'scripts/stop-stack.ps1',
    'scripts/start-litellm-proxy.py',
    'scripts/diagnose-local-env.mjs',
    'scripts/stop-windows.ps1',
    'scripts/migrate-portable-data.ps1',
    'scripts/migrate-portable-data.mjs',
    'package.json',
    'config.yaml',
    '.env.local',
    'LICENSE',
    'start-windows.cmd',
    'stop-windows.cmd',
    '迁移旧版数据.cmd',
    '使用说明.txt',
    '环境自检.cmd',
    'portable-manifest.json',
  ]) {
    assert.ok(fs.existsSync(path.join(output, ...expected.split('/'))), `成品缺少 ${expected}`);
  }
  assert.ok(!fs.existsSync(path.join(output, 'scripts', 'probe-do-not-package.ts')), '开发/探针脚本不得进入免安装包');
  assert.ok(!fs.existsSync(path.join(output, 'dist-desktop', 'main.js.map')), '桌面壳 sourcemap 不得进入免安装包');
  assert.ok(!fs.existsSync(path.join(output, 'dist-desktop', 'stale.js')), '桌面壳历史残留产物不得进入免安装包');
  for (const forbidden of ['.venv-litellm', 'data', 'storage', 'outputs', 'docs', '.git', '.cache', 'dist', 'desktop', 'installer']) {
    assert.ok(!fs.existsSync(path.join(output, forbidden)), `成品不得包含 ${forbidden}`);
  }

  // start-windows.cmd 必须是 portable 模板（显式 -Portable）
  const startCmd = fs.readFileSync(path.join(output, 'start-windows.cmd'), 'utf8');
  assert.match(startCmd, /-Portable/, '成品 start-windows.cmd 必须显式传 -Portable');
  const outputEnv = fs.readFileSync(path.join(output, '.env.local'), 'utf8');
  assert.doesNotMatch(outputEnv, /```/, '成品 .env.local 不得保留 Markdown 围栏');
  assert.match(outputEnv, /CREATIVE_STUDIO_SCRIPT_STUDIO_ENABLE_SCHEDULER=1/, '去围栏不得改写环境变量');

  // manifest：仅含运行必需文件，size/sha256 与实际一致，不含密钥哨兵值
  const manifestRaw = fs.readFileSync(path.join(output, 'portable-manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.mode, 'windows-portable-v1');
  assert.equal(manifest.appVersion, '0.6.0');
  assert.match(manifest.builtAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof manifest.sourceCommit, 'string');
  assert.ok(Array.isArray(manifest.files), 'manifest.files 必须是数组');
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  assert.ok(!byPath.has('使用说明.txt'), '可编辑使用说明不得进入 manifest 强校验');
  for (const key of [
    'node-runtime/node.exe',
    'node_modules/.bin/electron.cmd',
    'node_modules/electron/dist/electron.exe',
    '.next/standalone/server.js',
    '.next/standalone/runtime/server-entry.js',
    'python-runtime/python.exe',
    'python-runtime/runtime-manifest.json',
    'scripts/start-desktop-windows.ps1',
    'scripts/start-stack.ps1',
    'scripts/start-litellm-proxy.py',
    'config.yaml',
    '.env.local',
    'stop-windows.cmd',
    '迁移旧版数据.cmd',
  ]) {
    const entry = byPath.get(key);
    assert.ok(entry, `manifest 缺少关键文件条目 ${key}`);
    const abs = path.join(output, ...key.split('/'));
    assert.equal(entry.size, fs.statSync(abs).size, `manifest size 与实际不符：${key}`);
    assert.equal(entry.sha256, sha256File(abs), `manifest sha256 与实际不符：${key}`);
  }
  assert.ok(!manifestRaw.includes('SENTINEL_CONFIG_SECRET'), 'manifest 不得包含 config.yaml 内容');
  assert.ok(!run.stdout.includes('SENTINEL_CONFIG_SECRET'), '装配输出不得打印密钥内容');

  // ── 目标已存在：拒绝覆盖 ──
  const rerun = runAssembly(fixture, output);
  assert.notEqual(rerun.status, 0, '目标已存在时必须失败');
  assert.match(`${rerun.stdout}${rerun.stderr}`, /拒绝覆盖/, '必须提示拒绝覆盖');

  // ── 缺少 python-runtime：前置检查失败且不发布目录 ──
  const broken = makeFixture({ omit: ['python-runtime'] });
  const brokenOut = path.join(broken, 'out');
  const brokenRun = runAssembly(broken, brokenOut);
  assert.notEqual(brokenRun.status, 0, '缺少 python-runtime 时装配必须失败');
  assert.ok(!fs.existsSync(brokenOut), '装配失败不得发布目标目录');
  assert.ok(
    !fs.readdirSync(broken).some((name) => name.startsWith('.portable-staging-')),
    '装配失败必须清理临时目录',
  );

  console.log('windows-portable payload behavior tests passed');
} finally {
  for (const dir of cleanups) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
