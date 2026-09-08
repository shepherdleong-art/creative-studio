import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const exists = (path) => accessSync(path);

for (const path of [
  'scripts/build-win-installer.ps1',
  'installer/windows/CreativeStudio.iss',
  'installer/windows/launcher.cs',
  'installer/windows/stop-installed.ps1',
  'installer/windows/clear-user-data.ps1',
]) {
  exists(path);
}

const build = read('scripts/build-win-installer.ps1').replaceAll('\r\n', '\n');
const desktopService = read('desktop/service.ts');
const buildBytes = readFileSync('scripts/build-win-installer.ps1');
const stopBytes = readFileSync('installer/windows/stop-installed.ps1');
assert.deepEqual([...buildBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell build script must remain UTF-8 with BOM');
assert.deepEqual([...stopBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Installed stop script must remain UTF-8 with BOM');
const hasOnlyCrLf = (bytes) => bytes.every((byte, index) => byte !== 0x0a || (index > 0 && bytes[index - 1] === 0x0d));
assert.ok(hasOnlyCrLf(buildBytes), 'PowerShell build script must remain CRLF');
assert.ok(hasOnlyCrLf(stopBytes), 'Installed stop script must remain CRLF');
assert.match(build, /\[string\]\$NodeVersion = '22\.22\.3'/);
assert.match(build, /\$NodeName = "node-v\$NodeVersion-win-x64"/);
assert.match(build, /nodejs\.org\/dist\/v\$NodeVersion\/\$NodeName\.zip/);
assert.match(build, /process\.versions\.node\.split\('\.'\)\[0\]/);
assert.match(build, /process\.platform/);
assert.match(build, /process\.arch/);
assert.match(build, /\$HostNodeMajor -ne '22'/);
assert.match(build, /\$HostNodePlatform -ne 'win32'/);
assert.match(build, /\$HostNodeArch -ne 'x64'/);
assert.match(build, /npm\.cmd ci/);
const windowsNpmCiCommand = build.indexOf('& npm.cmd ci');
const windowsElectronInstallCommand = build.indexOf("& node.exe (Join-Path $Root 'node_modules\\electron\\install.js')");
const windowsMissingRuntime = build.indexOf('\n  throw "Electron runtime was not found at');
assert.notEqual(windowsNpmCiCommand, -1);
assert.notEqual(windowsElectronInstallCommand, -1);
assert.notEqual(windowsMissingRuntime, -1);
assert.ok(windowsNpmCiCommand < windowsElectronInstallCommand, 'Windows 必须在 npm ci 后按需执行 Electron installer');
assert.ok(windowsElectronInstallCommand < windowsMissingRuntime, 'Windows 必须在 Electron installer 后硬失败检查 runtime');
const windowsNpmCiBlockStart = build.indexOf('if ($SkipNpmCi) {');
const windowsNpmCiElse = build.indexOf('\n} else {', windowsNpmCiBlockStart);
const windowsNpmCiBlockEnd = build.indexOf('\n}\n\nif (-not (Test-Path (Join-Path $ElectronDist', windowsNpmCiElse);
assert.ok(windowsNpmCiBlockStart >= 0 && windowsNpmCiElse > windowsNpmCiBlockStart && windowsNpmCiBlockEnd > windowsNpmCiElse);
assert.doesNotMatch(build.slice(windowsNpmCiBlockStart, windowsNpmCiElse), /electron\\install\.js/, 'Windows skip 分支不得自动安装 Electron');
assert.match(build.slice(windowsNpmCiElse, windowsNpmCiBlockEnd), /npm\.cmd ci[\s\S]*if \(-not \(Test-Path \(Join-Path \$ElectronDist 'electron\.exe'\)\)\)[\s\S]*node\.exe \(Join-Path \$Root 'node_modules\\electron\\install\.js'\)/);
assert.match(build, /npm\.cmd run build/);
assert.match(build, /npm\.cmd run build:desktop/);
assert.match(build, /\$ElectronDist = Join-Path \$Root 'node_modules\\electron\\dist'/);
assert.match(build, /Copy-DirectoryContent -Source \$ElectronDist -Destination \$AppDir/);
assert.match(build, /Move-Item -LiteralPath \$electronExe -Destination \$productExe/);
assert.match(build, /resources\\app/);
assert.match(build, /main = 'dist-desktop\/main\.js'/);
assert.match(build, /Copy-DirectoryContent -Source \(Join-Path \$Root 'dist-desktop'\)/);
assert.match(build, /runtime\\node\.exe/);
assert.match(desktopService, /CREATIVE_STUDIO_DESKTOP: '1'/);
assert.match(build, /node_modules\\ffmpeg-static\\ffmpeg\.exe/);
assert.match(build, /node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe\.exe/);
assert.match(build, /dist-desktop.*-Include '\*\.map', '\*\.ts', '\*\.tsx'/s);
// 禁入清单单一来源：安装脚本必须从 forbidden-paths.json 派生出三层清单，
// 不得再硬编码重复清单（与 next.config.ts / build-mac-installer.sh 共用）。
const forbiddenSpec = JSON.parse(read('scripts/packaging/forbidden-paths.json'));
assert.equal(forbiddenSpec.version, 1, 'forbidden-paths.json schema version must be 1');
assert.ok(/^[\x00-\x7F]*$/.test(read('scripts/packaging/forbidden-paths.json')), 'forbidden-paths.json 必须保持 ASCII-only（Windows PowerShell 5.1 按 ANSI 读无 BOM 文件，非 ASCII 字节会破坏 ConvertFrom-Json）');
for (const entry of ['data', 'storage', 'outputs', 'docs', 'scripts', 'installer', '.git', '.env', '.env.*', '.claude', 'desktop', '.venv-litellm', 'config.yaml', 'litellm-config.yaml', 'python-runtime']) {
  assert.ok(forbiddenSpec.core.includes(entry), `共享禁入清单缺少 ${entry}`);
}
const winPruneSpec = forbiddenSpec.consumers.windowsInstallerPrune;
for (const extra of [
  ...forbiddenSpec.consumers.installerPruneCommon.extra,
  ...winPruneSpec.prunePayloadExtra,
  ...winPruneSpec.pruneStandaloneExtra,
  ...winPruneSpec.assertExtra,
]) {
  assert.ok(!forbiddenSpec.core.includes(extra), `windowsInstallerPrune 差集与 core 重叠：${extra}`);
}
assert.match(build, /Get-Content -LiteralPath \(Join-Path \$ScriptDir 'packaging\\forbidden-paths\.json'\) -Raw \| ConvertFrom-Json/, '安装脚本必须读取共享禁入清单 JSON');
assert.match(build, /\$payloadPrunePaths = @\(\$ForbiddenPaths\.core\) \+ @\(\$ForbiddenPaths\.consumers\.installerPruneCommon\.extra\) \+ @\(\$ForbiddenPaths\.consumers\.windowsInstallerPrune\.prunePayloadExtra\)/, 'payload 根 prune 清单必须等于 core+installerPruneCommon+prunePayloadExtra');
assert.match(build, /\$standalonePrunePaths = @\(\$ForbiddenPaths\.core\) \+ @\(\$ForbiddenPaths\.consumers\.windowsInstallerPrune\.pruneStandaloneExtra\)/, 'standalone 层 prune 清单必须等于 core+pruneStandaloneExtra');
assert.match(build, /\$forbiddenAssertPaths = @\(\$ForbiddenPaths\.core\) \+ @\(\$ForbiddenPaths\.consumers\.windowsInstallerPrune\.assertExtra\)/, '最终断言清单必须等于 core+assertExtra');
assert.doesNotMatch(build, /foreach \(\$relativePath in @\(\s*\r?\n\s*'data',/, '安装脚本不得再硬编码禁入清单数组');
assert.doesNotMatch(build, /\$forbiddenPayload = @\(/, '安装脚本不得再硬编码最终断言数组');
assert.doesNotMatch(build, /launcher\.cs|csc\.exe|Compile.*launcher/i, 'Windows packaging must not compile the legacy launcher');

const launcher = read('installer/windows/launcher.cs');
assert.match(launcher, /runtime", "node\.exe/);
assert.match(launcher, /EnvironmentVariables\["CREATIVE_STUDIO_DATA_ROOT"\] = storageBase/);
assert.match(launcher, /EnvironmentVariables\["CREATIVE_STUDIO_DESKTOP"\] = "1"/);

const pkg = JSON.parse(read('package.json'));
const iss = read('installer/windows/CreativeStudio.iss');
assert.match(iss, new RegExp(`#define MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
assert.match(iss, /ArchitecturesAllowed=x64compatible/);
assert.match(iss, /ArchitecturesInstallIn64BitMode=x64compatible/);
assert.match(iss, /Source: "\.\.\\\.\.\\dist\\windows\\CreativeStudio\\\*"/);
assert.match(iss, /Name: "\{autodesktop\}\\产品素材工作台"/);
assert.match(iss, /scripts\\stop-installed\.ps1/);
assert.match(iss, /scripts\\clear-user-data\.ps1/);
assert.doesNotMatch(iss, /launcher\.cs|launcher\.vbs/);

const stop = read('installer/windows/stop-installed.ps1');
assert.match(stop, /runtime\\desktop-service\.mjs/, '停止脚本必须引用桌面服务共享停机工具');
assert.match(stop, /\$desktopServiceTool\s+stop\s+--root\s+\$dataRoot/, '每受控数据根必须委托 desktop-service.mjs stop --root');
assert.match(stop, /runtime\\process-tree\.mjs/, '壳进程兜底必须引用共享进程树工具');
assert.match(stop, /\$processTreeTool\s+kill-tree/, '归属确认后的强杀必须经共享工具');
assert.match(stop, /Get-CimInstance Win32_Process/, '壳进程必须按进程名匹配');
assert.match(stop, /ExecutablePath/, '壳进程匹配必须校验可执行路径');
assert.match(stop, /CREATIVE_STUDIO_DATA_ROOT/, '必须扫描受控数据根环境变量');
assert.match(stop, /'CreativeStudio'/, '必须扫描 APPDATA 数据根');
assert.ok(
  stop.indexOf('$desktopServiceTool stop --root') < stop.indexOf('$processTreeTool kill-tree'),
  '必须先委托优雅停机再兜底强杀',
);
assert.doesNotMatch(stop, /Get-NetTCPConnection|LocalPort/, '不得内联端口探测');
assert.match(build, /scripts\\runtime\\desktop-service\.mjs/, '安装包必须装配共享桌面服务工具');
assert.match(build, /scripts\\runtime\\process-tree\.mjs/, '安装包必须装配共享进程树工具');

const clear = read('installer/windows/clear-user-data.ps1');
assert.match(clear, /Join-Path \$DataRoot 'data'/);
assert.match(clear, /Join-Path \$DataRoot 'storage'/);
assert.match(clear, /Join-Path \$env:APPDATA 'CreativeStudio'/);
assert.doesNotMatch(clear, /Remove-Item -LiteralPath \$Root\b/);

console.log('windows-installer tests passed');
