import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const schedule = path.join(root, 'scripts', 'team-server', 'schedule-backup.ps1');
const skip = process.platform !== 'win32' && '每日备份计划任务只在 Windows 目标主机可验证';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-backup-schedule-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const deploymentRoot = path.join(directory, 'deployment');
  const configPath = path.join(directory, 'deployment.json');
  const config = {
    schemaVersion: 1,
    deploymentId: 'studio-prod',
    releaseId: '2026.11.02',
    deploymentRoot,
    dataRoot: path.join(directory, 'data'),
    backupRoot: path.join(directory, 'backup'),
    oldRoots: [path.join(directory, 'old-workbench')],
    origin: 'https://studio.example.test',
    appPort: 3300,
    liteLLMPort: 4300,
    servicePrefix: 'CreativeStudio',
    serviceAccount: 'CONTOSO\\svc_studio$',
    certificate: {
      certPath: 'C:\\controlled\\certs\\studio.crt',
      keyPath: 'C:\\controlled\\certs\\studio.key',
    },
    allowedNetworks: ['192.0.2.0/24'],
    enableLiteLLM: false,
    maxRequestBytes: 64 * 1024 * 1024,
    stopTimeoutSeconds: 240,
  };
  fs.writeFileSync(configPath, JSON.stringify(config));
  return { directory, deploymentRoot, config, configPath };
}

function invoke(context, args) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', schedule,
    '-ConfigPath', context.configPath, ...args,
  ], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  return { ...result, json: lines.length ? JSON.parse(lines.at(-1)) : null };
}

test('预览输出固定任务合同且不写系统或备份根', { skip }, (t) => {
  const context = fixture(t);
  const localZone=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.TimeZoneInfo]::Local.Id'],{encoding:'utf8',windowsHide:true}).stdout.trim();
  const preview = invoke(context, ['-Action', 'preview', '-Time', '02:30', '-TimeZone', localZone]);
  assert.equal(preview.status, 0, preview.stderr);
  const plan = preview.json.plan;
  assert.equal(plan.taskName, 'CreativeStudioTeamBackup-studio-prod');
  assert.equal(plan.account, 'CONTOSO\\svc_studio$');
  assert.equal(plan.logonType, 'S4U');
  assert.equal(plan.timeZone, localZone);
  assert.match(plan.startBoundary, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/);
  assert.match(plan.command, /[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
  assert.ok(path.isAbsolute(plan.command));
  assert.ok(path.isAbsolute(plan.backupScript));
  assert.ok(plan.arguments.includes(`"${plan.backupScript}"`), '任务必须使用绝对备份脚本路径');
  assert.ok(plan.arguments.includes(`"${context.configPath}"`), '任务必须使用绝对配置路径');
  assert.match(plan.arguments, /-Type daily -Apply$/);
  assert.match(plan.arguments, /-NoProfile -NonInteractive/);
  assert.equal(plan.enabled, true);
  assert.equal(preview.json.existing.registered, false);
  assert.equal(fs.existsSync(context.config.backupRoot), false, 'preview 不得创建备份根');
  assert.equal(fs.existsSync(path.join(context.deploymentRoot, 'service')), false, 'preview 不得创建服务根');
  const foreignZone=invoke(context,['-Action','preview','-TimeZone',localZone==='UTC'?'China Standard Time':'UTC']);
  assert.notEqual(foreignZone.status,0,'不允许将其他时区的日历时间默认为本地时间');
});

test('时间/时区非法时 fail closed，不注册任何任务', { skip }, (t) => {
  const context = fixture(t);
  const badTime = invoke(context, ['-Action', 'preview', '-Time', '24:00']);
  assert.notEqual(badTime.status, 0);
  assert.match(badTime.stderr, /HH:mm/);
  const badZone = invoke(context, ['-Action', 'preview', '-Time', '02:30', '-TimeZone', 'Not/AZone']);
  assert.notEqual(badZone.status, 0);
  assert.match(badZone.stderr, /时区/);
});

test('状态汇总每日结果、恢复证据与 restore hold，未注册时不误报', { skip }, (t) => {
  const context = fixture(t);
  fs.mkdirSync(context.config.backupRoot, { recursive: true });
  fs.writeFileSync(path.join(context.config.backupRoot, 'daily-job.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'success',
    backupId: 'daily-1',
    latestRecoveryEvidence: { at: '2026-11-04T00:00:00.000Z', backupId: 'daily-1', evidenceStatus: 'complete' },
  }));
  const hold = path.join(context.config.dataRoot, 'storage', 'maintenance', 'restore-hold.json');
  fs.mkdirSync(path.dirname(hold), { recursive: true });
  fs.writeFileSync(hold, '{"schemaVersion":1}\n');
  const status = invoke(context, ['-Action', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.json.registered, false);
  assert.equal(status.json.managed, false);
  assert.equal(status.json.conflict, false);
  assert.equal(status.json.dailyJob.status, 'success');
  assert.equal(status.json.latestRecoveryEvidence.backupId, 'daily-1');
  assert.equal(status.json.restoreHold, true);
  const removeAbsent = invoke(context, ['-Action', 'remove']);
  assert.equal(removeAbsent.status, 0, removeAbsent.stderr);
  assert.equal(removeAbsent.json.removed, false, '删除不存在的任务必须幂等且不创建对象');
});

test('注册脚本固定多实例策略与归属校验，避免覆盖陌生任务', () => {
  const content = fs.readFileSync(schedule, 'utf8');
  assert.match(content, /-MultipleInstances IgnoreNew/);
  assert.match(content, /-StartWhenAvailable/);
  assert.match(content, /New-TimeSpan -Hours 6/);
  assert.match(content, /New-ScheduledTaskPrincipal.*-LogonType/);
  assert.doesNotMatch(content, /<TimeZone>|<LogonType>ServiceAccount/);
  assert.match(content, /同名计划任务不属于本部署，拒绝修改或删除/);
  assert.match(content, /Get-ScheduledTask -TaskName/);
  assert.match(content, /Register-ScheduledTask -TaskName/);
  assert.match(content, /Unregister-ScheduledTask -TaskName/);
  assert.doesNotMatch(content, /Password/, '无人登录任务不接受明文口令参数');
});

test('内置受限账号默认使用 ServiceAccount，无需人工更改登录类型', { skip }, (t) => {
  const context=fixture(t);
  context.config.serviceAccount='NT AUTHORITY\\LocalService';
  fs.writeFileSync(context.configPath,JSON.stringify(context.config));
  const result=invoke(context,['-Action','preview']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.json.plan.logonType,'ServiceAccount');
  assert.equal(result.json.applyPerformed,false);
});
