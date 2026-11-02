import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-owner-'));
const workerPath = fileURLToPath(new URL('./team-runtime-owner-worker.ts', import.meta.url));
const children = new Set<ChildProcess>();

function startOwner(root: string, instanceId: string): ChildProcess {
  const child = spawn(process.execPath, [workerPath, root, instanceId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function waitForAcquisition(child: ChildProcess): Promise<{ instanceId: string; fence: number }> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error(`等待执行权超时：${stdout}\n${stderr}`)), 5_000);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      const line = stdout.split('\n').find((value) => value.includes('"event":"acquired"'));
      if (!line) return;
      clearTimeout(timeout);
      const acquired = JSON.parse(line) as { instanceId: string; fence: number };
      resolve({ instanceId: acquired.instanceId, fence: acquired.fence });
    });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`执行权进程提前退出 ${code}：${stderr}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill('SIGKILL');
  await exited;
}

try {
  const rootA = path.join(fixtureRoot, 'root-a');
  const rootB = path.join(fixtureRoot, 'root-b');
  const first = startOwner(rootA, 'instance-a1');
  const firstOwner = await waitForAcquisition(first);
  assert.deepEqual(firstOwner, { instanceId: 'instance-a1', fence: 1 });

  const competitor = startOwner(rootA, 'instance-a-competitor');
  assert.equal(await waitForExit(competitor), 2, '存活持有人不得被锁超时抢占');
  assert.equal(first.exitCode, null);

  const isolated = startOwner(rootB, 'instance-b1');
  assert.deepEqual(
    await waitForAcquisition(isolated),
    { instanceId: 'instance-b1', fence: 1 },
    '不同数据根必须能同时取得各自执行权',
  );

  await kill(first);
  const replacement = startOwner(rootA, 'instance-a2');
  assert.deepEqual(
    await waitForAcquisition(replacement),
    { instanceId: 'instance-a2', fence: 2 },
    '异常退出后操作系统释放锁，新实例取得递增 fence',
  );

  await kill(isolated);
  await kill(replacement);
  console.log('team runtime owner tests passed');
} finally {
  await Promise.all([...children].map(kill));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
