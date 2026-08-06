import assert from 'node:assert/strict';
import { accessSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const exists = (path) => accessSync(path);

for (const path of [
  'scripts/build-win-installer.ps1',
  'installer/windows/CreativeStudio.iss',
  'installer/windows/launcher.cs',
  'installer/windows/restart-company-sidecar.ps1',
  'installer/windows/stop-installed.ps1',
  'installer/windows/clear-user-data.ps1',
]) {
  exists(path);
}

const build = read('scripts/build-win-installer.ps1');
const nextConfig = read('next.config.ts');
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
assert.match(build, /npm\.cmd run build/);
assert.match(nextConfig, /outputFileTracingExcludes:\s*\{\s*'\/\*':/);
assert.match(nextConfig, /'\.\/provisioning\/\*\*\/\*'/);
assert.match(build, /Turbopack\/NFT must never see a previous assembled payload/);
assert.match(build, /Remove-Item -LiteralPath \$AppDir -Recurse -Force/);
assert.match(build, /node_modules\\ffmpeg-static\\ffmpeg\.exe/);
assert.match(build, /node_modules\\ffprobe-static\\bin\\win32\\x64\\ffprobe\.exe/);
assert.match(build, /node_modules\\@img\\sharp-win32-x64\\lib\\libvips-42\.dll/);
assert.match(build, /sharp-win32-x64\*\.node/);
assert.match(build, /libvips-cpp-\*\.dll/);
assert.match(build, /node_modules\\better-sqlite3\\build\\Release\\better_sqlite3\.node/);
assert.match(build, /Bundled sharp\/better-sqlite3 native runtime self-check failed/);
assert.match(build, /restart-company-sidecar\.ps1/);
for (const forbidden of ['data', 'storage', 'outputs', '.env.local', '.git', '.claude', '.tmp-pdf-text']) {
  assert.match(build, new RegExp(forbidden.replace('.', '\\.')));
}
for (const forbiddenName of ['config.yaml', 'litellm-config.yaml', 'runtime.env']) {
  assert.match(build, new RegExp(forbiddenName.replace('.', '\\.')));
}

const launcher = read('installer/windows/launcher.cs');
assert.match(launcher, /runtime", "node\.exe/);
assert.match(launcher, /EnvironmentVariables\["CREATIVE_STUDIO_DATA_ROOT"\] = storageBase/);
assert.match(launcher, /EnvironmentVariables\["CREATIVE_STUDIO_DESKTOP"\] = "1"/);
assert.match(launcher, /bool isInstalled/);
assert.match(launcher, /out bool isInstalled/);
assert.match(launcher, /StartCompanySidecar\(storageBase\)/);
assert.match(launcher, /EnvironmentVariables\["CREATIVE_STUDIO_MANAGED_DEPLOYMENT"\] = "1"/);
assert.doesNotMatch(launcher, /CREATIVE_STUDIO_PROXY_PORT|-ProxyPort\b/);
assert.doesNotMatch(launcher, /optional|offline|best[- ]effort/i);

const pkg = JSON.parse(read('package.json'));
const iss = read('installer/windows/CreativeStudio.iss');
assert.match(iss, new RegExp(`#define MyAppVersion "${pkg.version.replaceAll('.', '\\.')}"`));
assert.match(iss, /ArchitecturesAllowed=x64compatible/);
assert.match(iss, /ArchitecturesInstallIn64BitMode=x64compatible/);
assert.match(iss, /Source: "\.\.\\\.\.\\dist\\windows\\CreativeStudio\\\*"/);
assert.match(iss, /Name: "\{autodesktop\}\\产品素材工作台"/);
assert.match(iss, /scripts\\stop-installed\.ps1/);
assert.match(iss, /scripts\\clear-user-data\.ps1/);
assert.match(iss, /scripts\\restart-company-sidecar\.ps1/);

const stop = read('installer/windows/stop-installed.ps1');
assert.match(stop, /CommandLine\)\.Contains\(\$Root\)/);
assert.match(stop, /Get-NetTCPConnection -LocalPort \$Port -State Listen/);

const clear = read('installer/windows/clear-user-data.ps1');
assert.match(clear, /Join-Path \$Root 'data'/);
assert.match(clear, /Join-Path \$Root 'storage'/);
assert.match(clear, /Join-Path \$Root '\.env\.local'/);
assert.doesNotMatch(clear, /Remove-Item -LiteralPath \$Root\b/);

console.log('windows-installer tests passed');
