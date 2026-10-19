import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireSchemaUpgradeLock } from '../lib/schema-upgrade/lock.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForLine(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expected}`)), 3_000);
    stream.on('data', (chunk) => {
      buffer += String(chunk);
      if (buffer.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    stream.on('error', reject);
  });
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-schema-lock-'));
const lockDatabasePath = path.join(root, 'schema-upgrade.lock.db');

try {
  const first = await acquireSchemaUpgradeLock({
    lockDatabasePath,
    timeoutMs: 1_000,
    pollIntervalMs: 10,
  });
  let secondAcquired = false;
  const secondPromise = acquireSchemaUpgradeLock({
    lockDatabasePath,
    timeoutMs: 1_000,
    pollIntervalMs: 10,
  }).then((lock) => {
    secondAcquired = true;
    return lock;
  });

  await delay(50);
  assert.equal(secondAcquired, false, '第一个实例持锁时，第二个实例不得进入升级区');
  first.release();
  const second = await secondPromise;
  assert.equal(secondAcquired, true);
  second.release();

  const workerPath = fileURLToPath(new URL('./schema-upgrade-lock-worker.ts', import.meta.url));
  const worker = spawn(process.execPath, [workerPath, lockDatabasePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.ok(worker.stdout);
  await waitForLine(worker.stdout, 'locked');
  worker.kill('SIGKILL');
  await new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve());
    worker.once('error', reject);
  });

  const recovered = await acquireSchemaUpgradeLock({
    lockDatabasePath,
    timeoutMs: 1_000,
    pollIntervalMs: 10,
  });
  recovered.release();

  await assert.rejects(
    async () => {
      const held = await acquireSchemaUpgradeLock({
        lockDatabasePath,
        timeoutMs: 1_000,
        pollIntervalMs: 10,
      });
      try {
        await acquireSchemaUpgradeLock({
          lockDatabasePath,
          timeoutMs: 30,
          pollIntervalMs: 10,
        });
      } finally {
        held.release();
      }
    },
    (error: unknown) => error instanceof Error && error.name === 'SchemaUpgradeLockTimeoutError',
  );

  console.log('schema upgrade lock tests passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
