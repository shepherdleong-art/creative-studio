import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmdPath = path.join(root, 'installer', 'windows', '迁移旧版数据.cmd');
const ps1Path = path.join(root, 'scripts', 'migrate-portable-data.ps1');
const guidePath = path.join(root, 'installer', 'windows', '使用说明-portable.txt');

assert.ok(fs.existsSync(cmdPath), '缺少免安装版根目录的 迁移旧版数据.cmd 模板');
assert.ok(fs.existsSync(ps1Path), '缺少迁移入口 scripts/migrate-portable-data.ps1');
assert.ok(fs.existsSync(guidePath), '缺少免安装版使用说明');

const cmdBytes = fs.readFileSync(cmdPath);
const cmd = cmdBytes.toString('utf8');
assert.ok(cmd.includes('\r\n') && !/(?<!\r)\n/.test(cmd), '迁移 cmd 必须使用 CRLF');
assert.match(cmd, /chcp 65001/);
assert.match(cmd, /migrate-portable-data\.ps1/);
assert.match(cmd, /-NewRoot\s+"%~dp0\."/, '包根参数必须用结尾点号隔开反斜杠与闭合引号');

const ps1Bytes = fs.readFileSync(ps1Path);
assert.deepEqual([...ps1Bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], '迁移 PowerShell 必须是 UTF-8 BOM');
assert.ok(ps1Bytes.every((byte, index) => byte !== 0x0a || ps1Bytes[index - 1] === 0x0d), '迁移 PowerShell 必须使用 CRLF');
const ps1 = ps1Bytes.toString('utf8').slice(1);
assert.match(ps1, /FolderBrowserDialog/, '未传旧版目录时必须弹出目录选择器');
assert.match(ps1, /data\\workbench\.db/, '选择结果必须验证为旧版根目录');
assert.match(ps1, /stop-windows\.ps1/, '迁移前必须先停止当前新版进程');
assert.match(ps1, /Win32_Process/, '迁移前必须检查所选旧目录的残留进程');
assert.match(ps1, /taskkill\.exe[^\r\n]*\/T[^\r\n]*\/F/, '只对已确认归属的进程树执行强杀');
assert.match(ps1, /OrdinalIgnoreCase/, '目录归属判断必须忽略 Windows 路径大小写');
assert.match(ps1, /OwnedPrefix/, '目录归属必须使用带分隔符的根路径边界，不能误匹配相邻目录');
assert.match(ps1, /node-runtime\\node\.exe/, '迁移必须使用包内 Node');
assert.match(ps1, /migrate-portable-data\.mjs/);
assert.match(ps1, /--old-root/);
assert.match(ps1, /--new-root/);

const guide = fs.readFileSync(guidePath, 'utf8');
assert.match(guide, /给 AI Agent 的迁移任务/, '使用说明必须提供可直接交给本机 Agent 的迁移任务');
assert.match(guide, /公司共享盘 0\.6\.0 母版目录/, 'Agent 任务必须明确共享盘母版输入');
assert.match(guide, /本机旧版免安装目录/, 'Agent 任务必须明确旧版输入');
assert.match(guide, /新版本机目录/, 'Agent 任务必须明确本机目标输入');
assert.match(guide, /-OldRoot <旧版目录> -NewRoot <新版目录>/, 'Agent 任务必须调用受控迁移脚本');
assert.match(guide, /迁移退出码为 0 且新版根目录出现“迁移报告-\*\.json”/, 'Agent 任务必须有可检查的迁移完成条件');
assert.match(guide, /不读取、显示、上传或复述其内容/, 'Agent 任务必须保护随包密钥内容');
assert.match(guide, /不提交图片、视频、脚本或语音生成任务/, 'Agent 验收必须保持非计费');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), '创意工作台 portable wrapper '));
try {
  const fixtureScripts = path.join(fixtureRoot, 'scripts');
  const fixtureCmd = path.join(fixtureRoot, '迁移旧版数据.cmd');
  fs.mkdirSync(fixtureScripts, { recursive: true });
  fs.copyFileSync(cmdPath, fixtureCmd);
  fs.writeFileSync(
    path.join(fixtureScripts, 'migrate-portable-data.ps1'),
    `\ufeffparam([string]$NewRoot)\r\n` +
      `$ErrorActionPreference = 'Stop'\r\n` +
      `try {\r\n` +
      `  $resolved = [System.IO.Path]::GetFullPath($NewRoot)\r\n` +
      `  if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { throw 'ROOT_NOT_FOUND' }\r\n` +
      `  Write-Output 'ROOT_OK'\r\n` +
      `  exit 0\r\n` +
      `} catch {\r\n` +
      `  Write-Output ('ROOT_ERROR:' + $_.Exception.Message)\r\n` +
      `  exit 1\r\n` +
      `}\r\n`,
    'utf8',
  );

  const result = spawnSync(
    process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    ['/d', '/c', 'call', fixtureCmd],
    { encoding: 'utf8', input: '\r\n', timeout: 30_000, windowsHide: true },
  );
  assert.equal(
    result.status,
    0,
    `迁移入口必须把含空格、中文且以反斜杠结尾的包根作为一个合法参数传给 PowerShell：\n${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`,
  );
  assert.match(result.stdout, /ROOT_OK/, '迁移入口应把自身包根完整传给 PowerShell');
  assert.doesNotMatch(result.stdout, /Illegal characters in path|路径中有非法字符/i);
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('portable data migration wrapper contract test passed');
