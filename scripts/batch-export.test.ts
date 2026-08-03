import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { computeFingerprintFromFile } from '../lib/batch-production/fingerprint.ts';
import {
  publishBatchExportTarget,
  releaseBatchExportReservation,
  reserveBatchExportTarget,
} from '../lib/batch-production/batch-export.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-studio-batch-export-'));
const storageRoot = path.join(root, 'storage');
fs.mkdirSync(storageRoot, { recursive: true });

async function run(): Promise<void> {
  const videoSource = path.join(storageRoot, 'rendered.mp4');
  const coverSource = path.join(storageRoot, 'rendered.jpg');
  fs.writeFileSync(videoSource, Buffer.from('real-video-bytes'));
  fs.writeFileSync(coverSource, Buffer.from('real-cover-bytes'));

  const target = reserveBatchExportTarget({
    storageRoot,
    projectId: 'project-1',
    batchId: 'batch-1',
    productCode: '床垫 A',
    taskDate: '2026-08-03T00:00:00.000Z',
    scriptStableId: 'script-稳定-id',
    planSeq: 2,
    outputVersion: 3,
  });
  assert.match(target.videoFilename, /床垫 A-20260803-script-稳定-id-plan2-v3-export1\.mp4/);
  assert.equal(path.basename(target.coverFilename, '.jpg'), path.basename(target.videoFilename, '.mp4'));
  assert.ok(fs.existsSync(target.reservationAbsolutePath));

  await assert.rejects(
    publishBatchExportTarget({
      storageRoot,
      target,
      videoSource,
      coverSource,
      renderResult: { audioMode: 'silent_placeholder', productionReady: false },
      productionReady: true,
    }),
    /口播|productionReady|静音/i,
  );
  assert.ok(fs.existsSync(target.reservationAbsolutePath), 'production gate failure must retain reservation for retry');

  const published = await publishBatchExportTarget({
    storageRoot,
    target,
    videoSource,
    coverSource,
    renderResult: { audioMode: 'narration', productionReady: true },
    productionReady: true,
  });
  assert.ok(published.videoRelativePath.startsWith(path.join('projects', 'project-1', '批量成片', 'batch-1')));
  assert.equal(published.videoChecksum, await computeFingerprintFromFile(videoSource));
  assert.equal(published.coverChecksum, await computeFingerprintFromFile(coverSource));
  assert.ok(fs.statSync(published.videoAbsolutePath).size > 0);
  assert.ok(fs.statSync(published.coverAbsolutePath).size > 0);
  assert.ok(!fs.existsSync(target.reservationAbsolutePath));

  const second = reserveBatchExportTarget({
    storageRoot,
    projectId: 'project-1',
    batchId: 'batch-1',
    productCode: '床垫 A',
    taskDate: '20260803',
    scriptStableId: 'script-稳定-id',
    planSeq: 2,
    outputVersion: 3,
  });
  assert.equal(second.exportSequence, 2, 're-export must use a new export sequence');
  await publishBatchExportTarget({ storageRoot, target: second, videoSource, coverSource, productionReady: true, renderResult: { audioMode: 'narration', productionReady: true } });
  assert.ok(fs.existsSync(published.videoAbsolutePath), 're-export must not overwrite old video');
  assert.ok(fs.existsSync(published.coverAbsolutePath), 're-export must not overwrite old cover');

  const sanitizedTraversal = reserveBatchExportTarget({
    storageRoot, projectId: 'project-1', batchId: 'batch-1', productCode: '../../escape',
    taskDate: '20260803', scriptStableId: 'script', planSeq: 1, outputVersion: 1,
  });
  assert.equal(path.dirname(sanitizedTraversal.videoAbsolutePath), path.join(storageRoot, 'projects', 'project-1', '批量成片', 'batch-1'));
  assert.equal(sanitizedTraversal.videoFilename, '....escape-20260803-script-plan1-v1-export1.mp4');
  assert.ok(!sanitizedTraversal.videoRelativePath.split(/[\\/]/).includes('..'));
  releaseBatchExportReservation(storageRoot, sanitizedTraversal);

  const symlinkDir = path.join(storageRoot, 'projects', 'project-symlink', '批量成片');
  fs.mkdirSync(path.dirname(symlinkDir), { recursive: true });
  fs.symlinkSync(root, symlinkDir, 'dir');
  await assert.rejects(
    Promise.resolve().then(() => reserveBatchExportTarget({
      storageRoot, projectId: 'project-symlink', batchId: 'batch-1', productCode: 'safe',
      scriptStableId: 'script', planSeq: 1, outputVersion: 1,
    })),
    /符号链接|symlink|路径/i,
  );

  const released = reserveBatchExportTarget({
    storageRoot, projectId: 'project-2', batchId: 'batch-2', productCode: 'safe',
    scriptStableId: 'script', planSeq: 1, outputVersion: 1,
  });
  releaseBatchExportReservation(storageRoot, released);
  assert.ok(!fs.existsSync(released.reservationAbsolutePath));

  console.log('batch-export tests passed');
}

run().finally(() => fs.rmSync(root, { recursive: true, force: true }));
