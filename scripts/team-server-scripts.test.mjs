import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptRoot = path.join(root, 'scripts', 'team-server');
const scripts = ['generate-config.ps1', 'install.ps1', 'status.ps1', 'stop.ps1', 'preflight.ps1'];

function validConfig(directory) {
  return {
    schemaVersion: 1,
    deploymentId: 'studio-prod',
    releaseId: 'test-release',
    deploymentRoot: path.join(directory, 'new-deployment'),
    dataRoot: path.join(directory, 'new-data'),
    backupRoot: path.join(directory, 'new-backup'),
    oldRoots: [path.join(directory, 'old-workbench')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudio',
    serviceAccount: 'CONTOSO\\svc_studio$',
    certificate: { certPath: 'C:\\controlled\\studio.crt', keyPath: 'C:\\controlled\\studio.key' },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: true,
    stopTimeoutSeconds: 240,
  };
}

function invoke(script, args) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptRoot, script), ...args], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
}

test('所有团队服务 PS1 为 UTF-8 BOM 且可由 PowerShell 5.1 解析', { skip: process.platform !== 'win32' }, () => {
  for (const name of scripts) {
    const file = path.join(scriptRoot, name);
    const bytes = fs.readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} 缺 BOM`);
    const parsed = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      "$tokens=$null;$errors=$null;[void][System.Management.Automation.Language.Parser]::ParseFile($env:SCRIPT_TO_PARSE,[ref]$tokens,[ref]$errors);if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}",
    ], { encoding: 'utf8', windowsHide: true, env: { ...process.env, SCRIPT_TO_PARSE: file } });
    assert.equal(parsed.status, 0, `${name}: ${parsed.stdout}${parsed.stderr}`);
  }
});

test('install/status/stop 默认 dry-run，不创建新根、凭据、服务或防火墙', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-scripts-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = validConfig(directory);
  const configPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(configPath, JSON.stringify(config));
  for (const name of ['install.ps1', 'status.ps1', 'stop.ps1']) {
    const result = invoke(name, ['-ConfigPath', configPath, '-DeploymentId', 'studio-prod']);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(output.dryRun, true, name);
    assert.equal(output.applyPerformed, false, name);
    assert.equal(output.deploymentId, 'studio-prod', name);
    assert.equal(result.stdout.includes('fixture-control-token'), false);
  }
  assert.equal(fs.existsSync(config.deploymentRoot), false);
  assert.equal(fs.existsSync(config.dataRoot), false);
  assert.equal(fs.existsSync(config.backupRoot), false);
});

test('显式 DeploymentId 不匹配、根重叠和链接路径在 apply 前 fail closed', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-script-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(configPath, JSON.stringify(validConfig(directory)));
  for (const name of ['install.ps1', 'status.ps1', 'stop.ps1']) {
    const result = invoke(name, ['-ConfigPath', configPath, '-DeploymentId', 'other-deployment']);
    assert.notEqual(result.status, 0, name);
    assert.doesNotMatch(result.stdout + result.stderr, /token|secret|password/i);
  }
  const invalid = validConfig(directory);
  invalid.dataRoot = path.join(invalid.oldRoots[0], 'nested');
  fs.writeFileSync(configPath, JSON.stringify(invalid));
  const overlap = invoke('install.ps1', ['-ConfigPath', configPath]);
  assert.notEqual(overlap.status, 0);
  assert.equal(fs.existsSync(invalid.deploymentRoot), false);
});

test('apply 分支只认领精确服务路径，app 先于独立代理停机，网络变更受 Apply 门禁', () => {
  const install = fs.readFileSync(path.join(scriptRoot, 'install.ps1'), 'utf8').replace(/^\uFEFF/, '')
    + fs.readFileSync(path.join(scriptRoot, 'common.ps1'), 'utf8').replace(/^\uFEFF/, '')
    + fs.readFileSync(path.join(scriptRoot, 'generate-config.mjs'), 'utf8');
  const stop = fs.readFileSync(path.join(scriptRoot, 'stop.ps1'), 'utf8').replace(/^\uFEFF/, '');
  for (const required of ['Win32_Service', 'PathName', 'OrdinalIgnoreCase', 'New-NetFirewallRule', 'control-credential.json', 'Get-FileHash', 'serviceLogDirectory', '/api/team/health/ready', 'install-state.json']) {
    assert.ok(install.includes(required), `install 缺 ${required}`);
  }
  assert.match(install, /if \(-not \$Apply\)[\s\S]*exit 0[\s\S]*Set-TeamFirewall -Resolved/);
  assert.doesNotMatch(install, /Stop-Service|taskkill|stop-stack|stop-litellm/);
  assert.match(stop, /service-control\.mjs/);
  assert.ok(stop.indexOf('service-control.mjs') < stop.indexOf('CreativeStudioLiteLLM'));
  assert.ok(stop.indexOf('CreativeStudioLiteLLM') < stop.indexOf('CreativeStudioCaddy'));
  assert.match(stop, /if \(-not \$Apply\)[\s\S]*exit 0[\s\S]*service-control\.mjs/);
  assert.doesNotMatch(stop, /taskkill\s+\/IM|Get-Process\s+-Name/);
});

test('部署 ACL 允许执行，管理员与 SYSTEM 完整权限继承到已有子文件', { skip: process.platform !== 'win32' }, (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-server-acl-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const child = path.join(directory, 'child.txt');
  fs.writeFileSync(child, 'acl probe');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    . $env:ACL_HELPER
    $account=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    Grant-TeamAcl -Path $env:ACL_DIRECTORY -Account $account -Permission 'M' -Recurse
    $rules=([System.IO.File]::GetAccessControl($env:ACL_CHILD)).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])
    foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
      $found=@($rules | Where-Object {$_.IdentityReference.Value -eq $sid -and $_.IsInherited -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl})
      if($found.Count -eq 0) {throw "Missing inherited full control for $sid"}
    }
  `], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ACL_HELPER: path.join(scriptRoot, 'common.ps1'), ACL_DIRECTORY: directory, ACL_CHILD: child } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(fs.readFileSync(path.join(scriptRoot, 'install.ps1'), 'utf8'), /deploymentRoot\) -Account .* -Permission 'RX' -Recurse/);
});

test('重复安装识别 Windows 规范化子网掩码，但仍拒绝不同范围', {skip:process.platform!=='win32'},()=>{
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`
    . $env:NETWORK_HELPER
    if((ConvertTo-TeamNetworkKey '10.20.16.1/24') -ne (ConvertTo-TeamNetworkKey '10.20.16.0/255.255.255.0')) {throw 'Equivalent IPv4 ranges differ'}
    if((ConvertTo-TeamNetworkKey '2001:db8::1/64') -ne (ConvertTo-TeamNetworkKey '2001:db8::/ffff:ffff:ffff:ffff::')) {throw 'Equivalent IPv6 ranges differ'}
    if((ConvertTo-TeamNetworkKey '10.20.16.0/24') -eq (ConvertTo-TeamNetworkKey '10.20.0.0/16')) {throw 'Broader range accepted'}
    $rejected=$false;try{ConvertTo-TeamNetworkKey '10.20.16.0/255.0.255.0' | Out-Null}catch{$rejected=$true}
    if(-not $rejected){throw 'Invalid mask accepted'}
  `],{encoding:'utf8',windowsHide:true,env:{...process.env,NETWORK_HELPER:path.join(scriptRoot,'common.ps1')}});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
