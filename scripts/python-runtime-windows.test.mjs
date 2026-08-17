/**
 * python-runtime-win-x64 锁文件合同测试。
 * 锁文件是免安装包运行时的唯一事实来源：不得出现版本范围、latest、
 * 空哈希或非 Windows x64 目标；lock JSON 与 requirements 锁必须互相一致。
 *
 * 运行：node scripts/python-runtime-windows.test.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockJsonPath = path.join(root, 'scripts', 'python-runtime-win-x64.lock.json');
const requirementsLockPath = path.join(root, 'requirements-litellm-win-x64.lock.txt');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ── 文件存在 ──
assert.ok(fs.existsSync(lockJsonPath), '缺少 scripts/python-runtime-win-x64.lock.json');
assert.ok(fs.existsSync(requirementsLockPath), '缺少 requirements-litellm-win-x64.lock.txt');

// ── lock JSON 结构 ──
const lock = JSON.parse(fs.readFileSync(lockJsonPath, 'utf8'));
assert.equal(typeof lock.schemaVersion, 'number', 'schemaVersion 必须是数字');
assert.equal(lock.pythonVersion, '3.12.10', 'Python 基线必须锁定 3.12.10');
assert.equal(lock.pythonBuildStandaloneRelease, '20250529', 'python-build-standalone release 必须锁定 20250529');
assert.equal(lock.targetTriple, 'x86_64-pc-windows-msvc', '目标 triple 必须是 Windows x64，不允许其他平台');

const archiveName = `cpython-${lock.pythonVersion}+${lock.pythonBuildStandaloneRelease}-${lock.targetTriple}-install_only_stripped.tar.gz`;
assert.equal(
  lock.archiveUrl,
  `https://github.com/astral-sh/python-build-standalone/releases/download/${lock.pythonBuildStandaloneRelease}/${encodeURIComponent(archiveName)}`,
  'archiveUrl 必须是不可变 GitHub release 直链且与归档名一致',
);
assert.match(lock.archiveSha256, /^[0-9a-f]{64}$/, 'archiveSha256 必须是 64 位小写十六进制，不得为空');
assert.match(lock.litellmVersion, /^\d+\.\d+\.\d+$/, 'litellmVersion 必须是精确版本，不得是范围或 latest');
assert.match(lock.dependencyLockSha256, /^[0-9a-f]{64}$/, 'dependencyLockSha256 必须是 64 位小写十六进制');
assert.equal(typeof lock.buildScriptVersion, 'number', 'buildScriptVersion 必须是数字');

// ── 禁止浮动引用 ──
const raw = fs.readFileSync(lockJsonPath, 'utf8');
assert.ok(!/latest/i.test(raw), '锁文件不得出现 latest');
assert.ok(!/>=|~|\^/.test(JSON.stringify({ v: lock.pythonVersion, l: lock.litellmVersion })), '版本字段不得含范围符号');
for (const key of ['archiveSha256', 'dependencyLockSha256']) {
  assert.ok(lock[key] && lock[key].length === 64, `${key} 不得为空哈希`);
}

// ── requirements 锁格式：每行都是 name==精确版本 ──
const lines = fs.readFileSync(requirementsLockPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
assert.ok(lines.length >= 50, '依赖锁行数异常少，导出可能不完整');
for (const line of lines) {
  assert.match(line, /^[A-Za-z0-9_.-]+==[0-9][A-Za-z0-9.!+]*$/, `依赖锁行必须是 name==精确版本：${line}`);
  assert.ok(!/latest|>=|~=|\^/.test(line), `依赖锁不得含浮动版本：${line}`);
}
const litellmLine = lines.find((line) => line.toLowerCase().startsWith('litellm=='));
assert.ok(litellmLine, '依赖锁必须包含 litellm== 精确版本');
assert.equal(litellmLine, `litellm==${lock.litellmVersion}`, 'lock JSON 的 litellmVersion 必须与依赖锁一致');
assert.ok(lines.some((line) => line === 'socksio==1.0.0'), '依赖锁必须保留 socksio（本机 SOCKS 代理传输）');

// ── 交叉一致性：lock JSON 记录的依赖锁哈希必须等于文件实际哈希 ──
assert.equal(
  lock.dependencyLockSha256,
  sha256File(requirementsLockPath),
  'dependencyLockSha256 与 requirements-litellm-win-x64.lock.txt 实际内容不一致',
);

// ======================================================================
// 任务 B2：构建/验证脚本静态合同测试
// 只读源码断言，不执行脚本；真实构建验收由维护者运行构建脚本完成。
// ======================================================================
const buildScriptPath = path.join(root, 'scripts', 'build-python-runtime-windows.ps1');
const verifyScriptPath = path.join(root, 'scripts', 'verify-python-runtime-windows.ps1');
const entryScriptPath = path.join(root, 'scripts', 'start-litellm-proxy.py');

assert.ok(fs.existsSync(buildScriptPath), '缺少 scripts/build-python-runtime-windows.ps1');
assert.ok(fs.existsSync(verifyScriptPath), '缺少 scripts/verify-python-runtime-windows.ps1');
assert.ok(fs.existsSync(entryScriptPath), '缺少 scripts/start-litellm-proxy.py');

function readPs1(filePath, label) {
  const buf = fs.readFileSync(filePath);
  assert.ok(
    buf.length > 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    `${label} 必须是 UTF-8 带 BOM（PS 5.1 按 ANSI 读无 BOM 中文会解析失败）`,
  );
  const text = buf.toString('utf8').slice(1);
  assert.ok(text.includes('\r\n'), `${label} 必须使用 CRLF 行尾`);
  assert.ok(!/(?<!\r)\n/.test(text), `${label} 不得混入裸 LF`);
  return text;
}

// ── LiteLLM 启动入口：固定内容，不经 litellm.exe ──
const entryPy = fs.readFileSync(entryScriptPath, 'utf8');
assert.equal(
  entryPy.trim(),
  'from litellm import run_server\n\nif __name__ == "__main__":\n    run_server()',
  'start-litellm-proxy.py 必须是方案 §B4 的固定入口（避免 litellm.exe 内嵌构建机绝对路径）',
);

// ── 构建脚本合同 ──
const build = readPs1(buildScriptPath, '构建脚本');

// 1. 平台硬校验：Windows + x64
assert.match(build, /Win32NT/, '构建脚本必须硬校验 Windows 平台');
assert.match(build, /PROCESSOR_ARCHITECTURE/, '构建脚本必须检查处理器架构');
assert.match(build, /'AMD64'/, '构建脚本必须硬校验 x64（AMD64）');

// 2. 读取锁文件并交叉校验依赖锁哈希
assert.match(build, /python-runtime-win-x64\.lock\.json/, '构建脚本必须读取 runtime lock JSON');
assert.match(build, /dependencyLockSha256/, '构建脚本必须交叉校验依赖锁哈希');

// 3. 下载到 .cache\python-runtime\，支持镜像基址覆盖；SHA-256 不匹配即删缓存并失败
assert.match(build, /\.cache\\python-runtime/, '归档必须下载到 .cache\\python-runtime\\');
assert.match(build, /PYTHON_RUNTIME_ARCHIVE_BASE/, '构建脚本必须支持 PYTHON_RUNTIME_ARCHIVE_BASE 镜像覆盖');
assert.match(build, /Get-FileHash/, '构建脚本必须计算归档哈希');
assert.match(build, /SHA256/i, '构建脚本必须使用 SHA-256');
assert.match(build, /archiveSha256/, '构建脚本必须对照 lock 的 archiveSha256');
assert.match(
  build,
  /Remove-Item[^\r\n]*\$archivePath[\s\S]{0,200}?Fail\s*\(?\s*[`"']?归档 SHA-256 不匹配/,
  'SHA-256 不匹配必须先删除缓存归档再失败',
);

// 4. 独立 staging 解压，不覆盖现有 python-runtime/；硬断言自带 pip，不得现场装 pip
assert.match(build, /staging/, '构建脚本必须使用独立 staging 目录');
assert.match(build, /-m pip --version/, '构建脚本必须硬断言 staging 自带可运行 pip');
assert.doesNotMatch(build, /ensurepip|get-pip/i, '构建脚本不得使用 ensurepip/get-pip 现场补 pip');
const firstStaging = build.indexOf('staging');
const publishIndex = build.indexOf('Move-Item $stagingRuntime $finalDir');
assert.ok(firstStaging !== -1 && publishIndex > firstStaging, 'staging 必须先于原子发布出现');

// 5/6. pip download 纯 wheel + wheelhouse 离线安装，逐 wheel 记录哈希
assert.match(build, /-m pip download/, '构建脚本必须执行 pip download');
assert.match(build, /--only-binary=:all:/, 'pip download 必须 --only-binary=:all:（任何源码包即失败）');
assert.match(build, /wheelhouse/, '构建脚本必须使用临时 wheelhouse');
assert.match(build, /-m pip install/, '构建脚本必须执行 pip install');
assert.match(build, /--no-index/, '安装必须 --no-index（证明不依赖网络与浮动解析）');
assert.match(build, /--find-links/, '安装必须 --find-links 指向 wheelhouse');
assert.match(build, /\*\.whl/, '构建脚本必须遍历 wheelhouse 的 *.whl');
assert.match(build, /Get-FileHash -Algorithm SHA256 \$_[^\r\n]*whl|Get-FileHash -Algorithm SHA256 \$wheel|sha256 = \(Get-FileHash/i, '必须逐 wheel 记录 SHA-256');

// 7. 运行时入口只走包内解释器 + start-litellm-proxy.py，不调 litellm.exe
assert.match(build, /start-litellm-proxy\.py/, '构建脚本必须通过 start-litellm-proxy.py 实测启动');
assert.doesNotMatch(build, /litellm\.exe/, '构建脚本不得调用 pip 生成的 litellm.exe');

// 8. 版本验证三件套
assert.match(build, /--version/, '必须验证 python --version');
assert.match(build, /importlib\.metadata/, '必须用 importlib.metadata 断言 litellm 精确版本');
assert.match(build, /from litellm import run_server/, '必须验证 from litellm import run_server');
assert.match(build, /LITELLM_LOCAL_MODEL_COST_MAP/, '构建脚本必须固定本地 model cost map（导入 litellm 不得联网）');

// 9/10. 实测启动 LiteLLM：临时最小配置、固定 loopback、健康检查、按 PID 受控停止；清代理/包索引环境
assert.match(build, /master_key: sk-build-smoke/, '实测启动必须使用假密钥的临时最小配置');
assert.match(build, /127\.0\.0\.1/, '实测启动必须固定监听 127.0.0.1');
assert.match(build, /\/health\/liveliness/, '必须等待 \/health\/liveliness 健康检查');
assert.match(build, /Stop-Process -Id \$proc\.Id/, '必须按 PID 受控停止实测进程');
assert.match(build, /HTTP_PROXY/, '实测启动前必须清除代理环境变量');
assert.match(build, /PIP_INDEX_URL/, '实测启动前必须清除包索引环境变量');

// 11. VC++ Runtime 私副本检查并记录，缺失即失败不静默
assert.match(build, /vcruntime140\.dll/, '构建脚本必须检查 VC++ Runtime 私副本');
assert.match(build, /vcRuntime/, 'VC++ 检查结果必须写入 manifest');

// 12. runtime-manifest.json：字段齐备，不含用户名
assert.match(build, /runtime-manifest\.json/, '构建脚本必须写 runtime-manifest.json');
assert.match(build, /builtAt/, 'manifest 必须记录构建时间');
assert.match(build, /buildScriptVersion/, 'manifest 必须记录构建脚本版本');
assert.match(build, /wheels/, 'manifest 必须包含 wheel 哈希清单');
assert.doesNotMatch(build, /USERNAME/, '构建脚本不得把机器用户名写入 manifest');

// 13. 第三方许可证：PBS 自带保留 + 包许可证汇总
assert.match(build, /THIRD-PARTY-LICENSES/, '构建脚本必须汇总第三方许可证');
assert.match(build, /LICENSE\.txt|licenses/, '构建脚本必须校验并保留 PBS 自带许可证');

// 14. 原子发布：先改名备份 → 再改名 staging → 失败回滚 → 成功删备份
assert.match(build, /python-runtime\.backup-/, '发布前必须把旧目录改名为同盘备份');
assert.match(build, /Move-Item \$finalDir \$backupDir/, '原子发布第一步：旧目录改名备份');
assert.match(build, /Move-Item \$stagingRuntime \$finalDir/, '原子发布第二步：staging 改名为 python-runtime/');
assert.match(build, /Move-Item \$backupDir \$finalDir/, '发布失败必须把备份改名回 python-runtime/（回滚）');
assert.doesNotMatch(
  build,
  /Remove-Item[^\r\n]*\$finalDir/,
  '任何路径不得直接删除唯一可用的 python-runtime/（只许改名备份）',
);

// ── 验证脚本合同（只读验收）──
const verify = readPs1(verifyScriptPath, '验证脚本');
assert.match(verify, /--version/, '验证脚本必须检查 Python 版本');
assert.match(verify, /importlib\.metadata/, '验证脚本必须检查 LiteLLM 精确版本');
assert.match(verify, /from litellm import run_server/, '验证脚本必须检查 run_server 导入');
assert.match(verify, /LITELLM_LOCAL_MODEL_COST_MAP/, '验证脚本必须固定本地 model cost map（导入 litellm 不得请求 GitHub 远程价格表）');
assert.match(verify, /runtime-manifest\.json/, '验证脚本必须解析 runtime-manifest.json');
assert.match(verify, /sha256/i, '验证脚本必须对 manifest 哈希清单做抽查');
assert.match(verify, /USERNAME/, '验证脚本必须检查 manifest 不含机器用户名');
assert.doesNotMatch(verify, /-m pip (install|download)/, '验证脚本不得执行任何 pip 变更');
assert.doesNotMatch(verify, /Invoke-WebRequest|Invoke-RestMethod/, '验证脚本不得联网');
assert.doesNotMatch(verify, /config\.yaml|\.env\.local/, '验证脚本不得读取密钥配置文件');
assert.doesNotMatch(verify, /api[_-]?key|secret/i, '验证脚本不得接触密钥字段');

console.log('python-runtime windows lock + build/verify contract tests passed');
