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
    planSeq: 2,
    outputVersion: 3,
    exportDirName: 'project-1',
  });
  // 命名合约与单条模式一致:成片-<产品编码>-<YYYYMMDD>-<两位成片序号>,首次导出不带重复后缀
  assert.equal(target.videoFilename, '成片-床垫 A-20260803-02.mp4');
  assert.equal(target.coverFilename, '成片-床垫 A-20260803-02-封面.jpg');
  assert.ok(fs.existsSync(target.reservationAbsolutePath));

  // 生产身份冻结后批量成片使用 `<基础名>-<两位序号>`（无「成片-」前缀）——2026-09-03 命名统一
  const identityNamed = reserveBatchExportTarget({
    storageRoot,
    projectId: 'project-identity',
    batchId: 'batch-identity',
    productCode: 'XQ9A',
    taskDate: '20260903',
    planSeq: 2,
    outputVersion: 3,
    exportDirName: '20260903-B店-XQ9A-AI种草-紫菜卷',
    baseName: '20260903-B店-XQ9A-AI种草-紫菜卷',
  });
  assert.equal(identityNamed.videoFilename, '20260903-B店-XQ9A-AI种草-紫菜卷-02.mp4');
  assert.equal(identityNamed.coverFilename, '20260903-B店-XQ9A-AI种草-紫菜卷-02-封面.jpg');
  assert.ok(identityNamed.videoRelativePath.startsWith(path.join('projects', '20260903-B店-XQ9A-AI种草-紫菜卷', '成片')));
  releaseBatchExportReservation(storageRoot, identityNamed);

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
  // 与单条模式同一个成品目录
  assert.ok(published.videoRelativePath.startsWith(path.join('projects', 'project-1', '成片')));
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
    planSeq: 2,
    outputVersion: 3,
    exportDirName: 'project-1',
  });
  assert.equal(second.exportSequence, 2, 're-export must use a new export sequence');
  assert.equal(second.videoFilename, '成片-床垫 A-20260803-02-02.mp4', '重复导出同一条成片才往后排序号');
  await publishBatchExportTarget({ storageRoot, target: second, videoSource, coverSource, productionReady: true, renderResult: { audioMode: 'narration', productionReady: true } });
  assert.ok(fs.existsSync(published.videoAbsolutePath), 're-export must not overwrite old video');
  assert.ok(fs.existsSync(published.coverAbsolutePath), 're-export must not overwrite old cover');

  const sanitizedTraversal = reserveBatchExportTarget({
    storageRoot, projectId: 'project-1', batchId: 'batch-1', productCode: '../../escape',
    taskDate: '20260803', planSeq: 1, outputVersion: 1, exportDirName: 'project-1',
  });
  assert.equal(path.dirname(sanitizedTraversal.videoAbsolutePath), path.join(storageRoot, 'projects', 'project-1', '成片'));
  assert.equal(sanitizedTraversal.videoFilename, '成片-....escape-20260803-01.mp4');
  assert.ok(!sanitizedTraversal.videoRelativePath.split(/[\\/]/).includes('..'));
  releaseBatchExportReservation(storageRoot, sanitizedTraversal);

  const symlinkDir = path.join(storageRoot, 'projects', 'project-symlink', '成片');
  fs.mkdirSync(path.dirname(symlinkDir), { recursive: true });
  fs.symlinkSync(root, symlinkDir, 'dir');
  await assert.rejects(
    Promise.resolve().then(() => reserveBatchExportTarget({
      storageRoot, projectId: 'project-symlink', batchId: 'batch-1', productCode: 'safe',
      planSeq: 1, outputVersion: 1, exportDirName: 'project-symlink',
    })),
    /符号链接|symlink|路径/i,
  );

  const released = reserveBatchExportTarget({
    storageRoot, projectId: 'project-2', batchId: 'batch-2', productCode: 'safe',
    planSeq: 1, outputVersion: 1, exportDirName: 'project-2',
  });
  releaseBatchExportReservation(storageRoot, released);
  assert.ok(!fs.existsSync(released.reservationAbsolutePath));

  // 导出目录名由调用方解析(<产品编码>-<日期>),不在本模块内重算
  const namedDir = reserveBatchExportTarget({
    storageRoot, projectId: 'project-3', batchId: 'batch-3', productCode: 'G564',
    taskDate: '20260807', planSeq: 1, outputVersion: 1, exportDirName: 'G564-20260807',
  });
  assert.equal(path.dirname(namedDir.videoAbsolutePath), path.join(storageRoot, 'projects', 'G564-20260807', '成片'));
  assert.equal(namedDir.videoFilename, '成片-G564-20260807-01.mp4');
  releaseBatchExportReservation(storageRoot, namedDir);

  console.log('batch-export tests passed');
}

run().finally(() => fs.rmSync(root, { recursive: true, force: true }));
