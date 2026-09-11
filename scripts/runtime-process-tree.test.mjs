// scripts/runtime-process-tree.test.mjs
// process-tree.mjs 单测：长驻 node 子进程的进程信息、归属判定与 killTree。
// 双平台语义：
// - Windows：getProcessInfo 用 CIM（ExecutablePath/CommandLine/ParentProcessId，无 cwd），
//   killTree 走 taskkill /T /F；
// - unix：ps + lsof cwd，killTree 走进程组 SIGTERM → 2s → SIGKILL。
// 测试代码本身平台无关（spawn/kill 都可跨平台），在当前平台（win32）必须通过。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProcessInfo, isOwnedByRoot, killTree } from './runtime/process-tree.mjs';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-pt-'));
const unrelated = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-pt-other-'));

// Windows 的 CIM 拿不到子进程 cwd，把沙箱路径嵌入 -e 脚本：
// 命令行归属检查会命中该路径（unix 下则 cwd 直接命中，语义一致）。
const embedded = sandbox.replaceAll('\\', '/');
const child = spawn(process.execPath, [
  '-e',
  `const sandbox = "${embedded}"; setInterval(() => {}, 1000);`,
], {
  cwd: sandbox,
  stdio: 'ignore',
});

const exited = new Promise((resolve) => child.once('exit', resolve));

try {
  const info = await getProcessInfo(child.pid);
  assert.ok(info, 'getProcessInfo 应返回长驻子进程信息');
  assert.equal(info.pid, child.pid);
  assert.equal(info.ppid, process.pid, '子进程的直接父进程应是本测试进程');
  assert.equal(typeof info.commandLine, 'string');
  assert.ok(info.commandLine.length > 0);
  if (process.platform !== 'win32') {
    assert.equal(info.cwd, sandbox, 'unix 下应能从 lsof 取到 cwd');
  } else {
    assert.equal(info.cwd, null, 'Windows 下不提供 cwd（CIM 语义）');
    assert.equal(typeof info.executablePath, 'string');
  }

  // 归属判定：沙箱（cwd/命令行命中）属于；无关目录不属于；不存在的 PID 不属于。
  assert.equal(await isOwnedByRoot(child.pid, sandbox), true, '沙箱目录应判定为项目内');
  assert.equal(await isOwnedByRoot(child.pid, unrelated), false, '无关目录不应判定为项目内');
  assert.equal(await isOwnedByRoot(9_999_999, sandbox), false, '不存在的 PID 不应属于任何目录');

  // killTree 后进程退出；不存在的 PID 返回 false（已停止，不算失败）。
  const killResult = await killTree(child.pid);
  assert.equal(killResult, true, 'killTree 对存在的进程应返回 true');
  const exitState = await Promise.race([
    exited.then(() => 'exited'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
  ]);
  assert.equal(exitState, 'exited', 'killTree 后子进程应在 10 秒内退出');
  assert.equal(await killTree(9_999_999), false, 'killTree 对已不存在的进程应返回 false');
} finally {
  if (child.exitCode === null) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // 可能已经被回收。
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(unrelated, { recursive: true, force: true });
}

console.log('runtime process-tree test passed');
