import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmdPath = path.join(root, 'installer', 'windows', '迁移旧版数据.cmd');
const ps1Path = path.join(root, 'scripts', 'migrate-portable-data.ps1');

assert.ok(fs.existsSync(cmdPath), '缺少免安装版根目录的 迁移旧版数据.cmd 模板');
assert.ok(fs.existsSync(ps1Path), '缺少迁移入口 scripts/migrate-portable-data.ps1');

const cmdBytes = fs.readFileSync(cmdPath);
const cmd = cmdBytes.toString('utf8');
assert.ok(cmd.includes('\r\n') && !/(?<!\r)\n/.test(cmd), '迁移 cmd 必须使用 CRLF');
assert.match(cmd, /chcp 65001/);
assert.match(cmd, /migrate-portable-data\.ps1/);
assert.match(cmd, /-NewRoot\s+"%~dp0"/);

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

console.log('portable data migration wrapper contract test passed');
