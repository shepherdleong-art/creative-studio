// scripts/runtime-stack-state.test.mjs
// stack-state.mjs 单测：临时目录下验证写-读往返、无 BOM、损坏容错、clear 幂等、
// 未知字段剥离与类型纠偏。node 22 直跑，无测试框架。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearStackState,
  normalizeStackState,
  readStackState,
  stackFilePath,
  writeStackState,
} from './runtime/stack-state.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-stack-'));
const stackFile = stackFilePath(dir);

// 文件不存在返回 null。
assert.equal(readStackState(dir), null, '状态文件不存在应返回 null');

// 写-读往返一致 + 无 BOM + 未知字段被剥离 + 类型纠偏（字符串端口→数字）。
writeStackState(dir, {
  appPort: '3000',
  appPid: 111,
  appCmdPid: '222',
  litellmPid: 333,
  litellmPort: '4000',
  proxyPort: 4000,
  litellmRuntime: 'venv-litellm',
  litellmInterpreter: 'C:\\repo\\.venv-litellm\\Scripts\\litellm.exe',
  stopScript: 'scripts\\stop-stack.ps1',
  startedAt: '2026-09-08T12:00:00',
  unexpected: '应被剥离',
});
const raw = fs.readFileSync(stackFile);
assert.equal(
  raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
  false,
  'stack.json 必须是无 BOM 的 UTF-8',
);
const state = readStackState(dir);
assert.deepEqual(state, {
  version: 1,
  appPort: 3000,
  appPid: 111,
  appCmdPid: 222,
  litellmPid: 333,
  litellmPort: 4000,
  proxyPort: 4000,
  litellmRuntime: 'venv-litellm',
  litellmInterpreter: 'C:\\repo\\.venv-litellm\\Scripts\\litellm.exe',
  stopScript: 'scripts\\stop-stack.ps1',
  startedAt: '2026-09-08T12:00:00',
}, '写-读往返应与写人内容一致（已知键、类型纠偏、未知键剥离）');
assert.equal(Object.hasOwn(state, 'unexpected'), false, '未知字段必须被剥离');

// 原子写后同目录不留 tmp 文件。
assert.deepEqual(
  fs.readdirSync(path.dirname(stackFile)).filter((name) => name.includes('.tmp')),
  [],
  '原子写不应残留 tmp 文件',
);

// 旧文件缺字段（模拟 PS 版旧 schema）读取不抛错。
writeStackState(dir, { litellmPid: 42, proxyPort: 4000 });
assert.equal(readStackState(dir).version, 1);
assert.equal(readStackState(dir).litellmPid, 42);
assert.equal('appPort' in readStackState(dir), false, '缺字段应保持缺状态（读取方自行兜底）');

// 带 BOM 的文件也能读（lib/shutdown.ts 有同样的剥离处理）。
fs.writeFileSync(stackFile, '\uFEFF{"appPort":3000}', 'utf8');
assert.equal(readStackState(dir).appPort, 3000);

// 损坏 JSON → 读返回 null（并 warn），不抛错。
fs.writeFileSync(stackFile, '{bad json', 'utf8');
assert.equal(readStackState(dir), null, '损坏 JSON 应返回 null');

// clear 幂等：写过能清掉；重复清不抛错。
writeStackState(dir, { appPort: 3000 });
clearStackState(dir);
assert.equal(fs.existsSync(stackFile), false, 'clear 后文件应不存在');
assert.equal(readStackState(dir), null);
clearStackState(dir);
assert.equal(fs.existsSync(stackFile), false);

// normalizeStackState 直测：类型纠偏 + 未知字段剥离 + 非法值丢弃。
assert.deepEqual(
  normalizeStackState({ appPort: '8080', litellmPid: '42', startedAt: 123, bogus: 1 }),
  { appPort: 8080, litellmPid: 42, startedAt: '123' },
  'normalize 应做类型纠偏并剥离未知字段',
);
assert.deepEqual(
  normalizeStackState({ appPort: 'abc', litellmPid: -1, version: '2', litellmRuntime: null }),
  {},
  '无法纠偏的值应被丢弃，非 1 的 version 不保留',
);
assert.equal(normalizeStackState(null), null, '非对象输入返回 null');
assert.equal(normalizeStackState('text'), null);

// CLI 回归：PowerShell 管道按 $OutputEncoding 写 stdin 可能带 UTF-8 BOM，write 必须容忍。
{
  const { spawnSync } = await import('node:child_process');
  const toolPath = path.join(import.meta.dirname, 'runtime', 'stack-state.mjs');
  const result = spawnSync(process.execPath, [toolPath, 'write', dir], {
    input: '﻿{"litellmPid":123,"proxyPort":4000}',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `带 BOM 的 stdin 写入应成功: ${result.stderr}`);
  const written = readStackState(dir);
  assert.equal(written.litellmPid, 123);
  assert.equal(written.proxyPort, 4000);
  clearStackState(dir);
}

fs.rmSync(dir, { recursive: true, force: true });

console.log('runtime stack-state test passed');
