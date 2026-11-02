import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-team-transfer-space-'));
const { createTeamTransferSpace } = await import('../lib/team-service/transfers/space.ts');
const { TransferError } = await import('../lib/team-service/transfers/errors.ts');

try {
  const productionFile = path.join(root, 'existing-production.bin');
  fs.writeFileSync(productionFile, 'do-not-delete');
  const space = createTeamTransferSpace({
    storageRoot: root,
    safetyMarginBytes: 1024,
    statfs: async () => ({ bavail: 256, bsize: 4096 }),
  });
  const first = await space.reserve(512 * 1024);
  await assert.rejects(
    space.reserve(768 * 1024),
    (error: unknown) => error instanceof TransferError && error.code === 'insufficient_storage' && error.status === 507,
    '在途预留与安全余量必须阻止超额新写入',
  );
  assert.equal(fs.readFileSync(productionFile, 'utf8'), 'do-not-delete', '空间不足不得清理生产素材');
  await first.release();
  const second = await space.reserve(768 * 1024);
  await second.release();
  await first.release();
  const third = await space.reserve(768 * 1024);
  await third.release();

  let statfsCalls = 0;
  let openStatfs!: () => void;
  const statfsGate = new Promise<void>((resolve) => { openStatfs = resolve; });
  const concurrent = createTeamTransferSpace({
    storageRoot: root,
    safetyMarginBytes: 0,
    statfs: async () => {
      statfsCalls += 1;
      if (statfsCalls === 2) openStatfs();
      await statfsGate;
      return { bavail: 1024, bsize: 1 };
    },
  });
  const concurrentResults = await Promise.allSettled([concurrent.reserve(600), concurrent.reserve(600)]);
  assert.equal(concurrentResults.every((result) => result.status === 'fulfilled'), false,
    '并发空间预检不得让两个在途预留同时超额通过');
  for (const result of concurrentResults) {
    if (result.status === 'fulfilled') await result.value.release();
  }
  const afterConcurrent = await concurrent.reserve(1024);
  await afterConcurrent.release();

  const real = createTeamTransferSpace({ storageRoot: root, safetyMarginBytes: 0 });
  const realReservation = await real.reserve(1);
  await realReservation.release();

  console.log('PASS: dataRoot-volume statfs, atomic in-flight reservations, safety margin and non-destructive insufficient-storage pause');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
