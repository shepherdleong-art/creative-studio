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

const build = read('scripts/build-win-installer.ps1');
const desktopService = read('desktop/service.ts');
const buildBytes = readFileSync('scripts/build-win-installer.ps1');
const stopBytes = readFileSync('installer/windows/stop-installed.ps1');
assert.deepEqual([...buildBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell build script must remain UTF-8 with BOM');
assert.deepEqual([...stopBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Installed stop script must remain UTF-8 with BOM');
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
assert.notEqual(windowsNpmCiCommand, -1);
assert.ok(windowsNpmCiCommand < build.indexOf('Electron runtime was not found'), 'Windows 必须在 npm ci 后检查 Electron runtime');
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
for (const forbidden of ['data', 'storage', 'outputs', 'docs', 'scripts', 'installer', '.env.local', '.venv-litellm', 'config.yaml', 'litellm-config.yaml', '.git', '.claude', 'desktop']) {
  assert.match(build, new RegExp(forbidden.replace('.', '\\.')));
}
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
assert.match(stop, /Get-CimInstance Win32_Process/);
assert.match(stop, /ExecutablePath/);
assert.match(stop, /electron-service\.json/);
assert.match(stop, /ConvertFrom-Json/);
assert.match(stop, /ExpectedInstanceId/);
assert.match(stop, /api\/desktop\/health/);
assert.match(stop, /payload\.instanceId/);
assert.match(stop, /Invoke-WebRequest -Method Post/);
assert.match(stop, /\/api\/shutdown/);
assert.match(stop, /127\\\.0\\\.0\\\.1/);
assert.match(stop, /65535/);
assert.match(stop, /-TimeoutSec 15/);
assert.match(stop, /taskkill\.exe/);
assert.match(stop, /\/T \/F/);
assert.ok(stop.indexOf('/api/desktop/health') < stop.indexOf('/api/shutdown'), '必须先用 instanceId 健康检查确认服务身份');
assert.ok(stop.indexOf('/api/shutdown') < stop.indexOf('taskkill.exe'), '优雅停机必须先于 taskkill 兜底');
assert.doesNotMatch(stop, /Get-NetTCPConnection|LocalPort/);

const clear = read('installer/windows/clear-user-data.ps1');
assert.match(clear, /Join-Path \$DataRoot 'data'/);
assert.match(clear, /Join-Path \$DataRoot 'storage'/);
assert.match(clear, /Join-Path \$env:APPDATA 'CreativeStudio'/);
assert.doesNotMatch(clear, /Remove-Item -LiteralPath \$Root\b/);

console.log('windows-installer tests passed');
